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

### Restoring on a fresh box

```
git clone <this repo>
cd planka
scripts/decrypt-secrets.sh   # asks for the passphrase, restores .env etc.
```

That's the whole recovery story for secrets: the PLANKA Secrets Passphrase is the only thing
that needs to survive off this VM.
