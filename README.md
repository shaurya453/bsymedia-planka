# PLANKA deployment (BSY Media)

Self-hosted PLANKA (Trello-alternative) for ~100 internal staff, run from this repo via a
fork-and-build Docker pipeline. For the full history, rationale, and every feature/fix delivered,
see `CLAUDE.md` — this file is a shorter operational reference.

## Layout

- `planka-custom/` — `Dockerfile` clones upstream PLANKA at a pinned tag and applies
  `planka-custom/patches/*.patch` (numbered, one per change) before running upstream's own build.
  To change PLANKA's behavior, add a new numbered patch — never edit a running container by hand.
- `invite-service/` — small Node app handling self-signup/invite flow (replaces OIDC/SSO, which
  wasn't viable — see `CLAUDE.md`).
- `docker-compose.yml` — `planka`, `invite-service`, `postgres` (two databases: `planka` and
  `planka_ops`).
- `.env` — real runtime secrets (never committed). `.env.example` documents every key.
- `scripts/backup.sh` — daily (3am cron) Postgres dump (both DBs) + attachments volume tarball,
  kept locally for 14 days and mirrored offsite to Mega via an rclone `crypt` remote
  (client-side encrypted).
- `secrets/` — passphrase-encrypted copies of `.env`, the DuckDNS token, and the GitHub deploy
  SSH key, safe to commit. See below.

## Deploying a change

```
docker compose build planka        # rebuilds from planka-custom/, applying patches/
docker compose up -d planka
docker compose ps planka           # confirm "healthy"
```

## Secrets management

Runtime secrets (`.env`, `.secrets/duckdns.env`, the SSH key this repo uses to push to GitHub)
are deliberately git-ignored — they must never exist in the repo as plaintext. Instead,
passphrase-encrypted copies (`gpg --symmetric`, AES256) live in `secrets/` and *are* committed.

There is no keypair and no separate key file to lose — just a passphrase, which both encrypts
and decrypts. This is a **different passphrase from the Mega/rclone offsite backup**
(see `scripts/backup.sh`) — two passphrases total protect this whole system. Name them
distinctly wherever you store them, so it's unambiguous which is needed for which step during a
restore:

- **PLANKA Mega Backup Passphrase** — `rclone`'s Mega/crypt config; needed to pull the database
  and attachments backup down from Mega.
- **PLANKA Secrets Passphrase** — used below, by `scripts/encrypt-secrets.sh` /
  `scripts/decrypt-secrets.sh`; needed to restore `.env`, the DuckDNS token, and the GitHub
  deploy SSH key.

### Day-2: after rotating a secret

```
scripts/encrypt-secrets.sh   # asks for the passphrase (twice, to confirm), writes secrets/*.gpg
git diff --stat secrets/     # sanity-check what changed
git add secrets/ && git commit -m "rotate <whatever>" && git push
```

Must be run from a real terminal — gpg's passphrase prompt doesn't work from automation.

### Restoring secrets alone

```
git clone <this repo>
cd planka
scripts/decrypt-secrets.sh   # asks for the passphrase, restores .env etc.
```

That's the whole recovery story for secrets: the PLANKA Secrets Passphrase is the only thing
that needs to survive off this VM. For rebuilding the entire server, see "Disaster recovery"
below.

## Disaster recovery: restoring on a brand new server

If this VM is lost entirely, here's the full sequence to get back up and running. You need
**both** passphrases from the table above.

**1. New server, install Docker** (Docker Engine + Compose plugin). Nothing PLANKA-specific yet.

**2. Get the code back** — no passphrase needed, just GitHub access. Note: this has to be *your
own* GitHub credentials (personal SSH key or token), not the deploy key — the deploy key only
exists encrypted inside `secrets/github_deploy_key.gpg`, which is itself inside the repo you're
about to clone, so it can't bootstrap its own checkout. The old server's `~/.ssh/config` alias
(`github.com-planka`) also only exists on that server; it's not needed here — plain `git clone`
against your own account works fine, since only the deploy step later needs the dedicated key.
```
git clone git@github.com:shaurya453/bsymedia-planka.git
cd bsymedia-planka
```

**3. Restore secrets** (needs the **PLANKA Secrets Passphrase**):
```
scripts/decrypt-secrets.sh
```
Restores `.env`, `.secrets/duckdns.env`, and the GitHub deploy SSH key file itself — but not the
SSH config alias that points to it. If you want `git push` to use that dedicated key again
(rather than your own), recreate `~/.ssh/config`:
```
Host github.com-planka
  HostName github.com
  User git
  IdentityFile ~/.ssh/planka_deploy_key
  IdentitiesOnly yes
```
and re-point the remote: `git remote set-url origin git@github.com-planka:shaurya453/bsymedia-planka.git`.
Not required for day-1 recovery — your own GitHub credentials from step 2 work fine for pushing too.

**4. Reconnect to Mega** (needs the **PLANKA Mega Backup Passphrase**):
```
rclone config
```
Recreate the `megaremote` (Mega login) and `cryptremote` (crypt, points at `megaremote:planka-backups`)
remotes — these only ever lived on the old server, so they need to be re-entered once.

**5. Pull down the latest backup:**
```
rclone copy cryptremote:planka-backups/<latest-date-folder> ./restore
```
rclone decrypts automatically as it downloads.

**6. Restore the data:**
```
docker compose up -d postgres
gunzip -c restore/planka.sql.gz | docker compose exec -T postgres psql -U postgres -d planka
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE planka_ops;"
gunzip -c restore/planka_ops.sql.gz | docker compose exec -T postgres psql -U postgres -d planka_ops
docker run --rm -v planka_data:/dest -v "$PWD/restore":/src alpine tar xzf /src/data.tar.gz -C /dest
```
The `CREATE DATABASE planka_ops` step is required — a fresh Postgres container only
auto-creates the `planka` database (from `docker-compose.yml`'s `POSTGRES_DB=planka`), not
`planka_ops`; without it the next line fails with `database "planka_ops" does not exist`
(verified 2026-09-04 by actually running this sequence against a real backup in an isolated
stack).

**7. Start everything:**
```
docker compose up -d
```

**8. Point your domain's DNS at the new server's IP.**

That's the entire recovery story. Day-to-day, none of this runs — backups happen automatically
at 3am, and nothing here needs attention unless the server actually dies.
