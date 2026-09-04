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
- `secrets/` — encrypted copies of `.env`, the DuckDNS token, and the GitHub deploy SSH key,
  safe to commit. See below.

## Deploying a change

```
docker compose build planka        # rebuilds from planka-custom/, applying patches/
docker compose up -d planka
docker compose ps planka           # confirm "healthy"
```

## Secrets management

Runtime secrets (`.env`, `.secrets/duckdns.env`, the SSH key this repo uses to push to GitHub)
are deliberately git-ignored — they must never exist in the repo as plaintext. Instead,
GPG-encrypted copies live in `secrets/` and *are* committed, using
[SOPS](https://github.com/getsops/sops) so only the values are encrypted (keys stay readable,
which makes `git diff` on a rotated secret meaningful).

**Recipient key**: `PLANKA Secrets <secrets@bsymedia-planka>`,
fingerprint `BF1F9D2C001719E61DC2AD66C74FDCF778435A45`. Encrypting only needs this key's public
half. Decrypting needs the private key imported into a local GPG keyring plus its passphrase.

**The private key itself is not in this repo** — it lives in this VM's GPG keyring
(`~/.gnupg`), protected by a passphrase, plus a portable encrypted export kept in a password
manager (off this VM). That export is the disaster-recovery anchor: if this VM's disk is lost,
GitHub gives you the encrypted `secrets/*.enc.*` files back, but only the off-VM key export (plus
its passphrase) can open them. **If that export doesn't exist yet, or only exists on this VM,
none of this protects you against VM loss — go export and relocate it before relying on this.**

### Day-2: after rotating a secret

```
scripts/encrypt-secrets.sh   # re-encrypts secrets/*.enc.* from the live .env / SSH key
git diff secrets/            # sanity-check what changed
git add secrets/ && git commit -m "rotate <whatever>" && git push
```

Runs without the passphrase (encryption only needs the public key).

### Restoring on a fresh box

```
gpg --import /path/to/planka-secrets-key-backup.asc   # prompts for the passphrase
git clone <this repo>
cd planka
scripts/decrypt-secrets.sh   # prompts for the passphrase (via gpg-agent), restores .env etc.
```

`scripts/decrypt-secrets.sh` needs a real terminal — gpg's passphrase prompt won't work from
non-interactive automation.

### Editing an encrypted file directly

`sops secrets/env.enc.env` opens it decrypted in `$EDITOR`, re-encrypting on save (uses
`.sops.yaml`'s creation rules, which match by path — only works for files already under
`secrets/`).
