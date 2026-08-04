# PLANKA deployment — technical notes

For the client's own admin, see `RUNBOOK.md` (written in Phase 6). This file is for whoever
maintains the stack technically next.

## What this is

Self-hosted PLANKA (Trello-alternative) for ~100 internal staff of one organization, replacing
their Trello workspace for cost reasons. Deployed per the brief in `planka-start.md` (repo root's
parent — kept outside this repo since it's the contractor's working brief, not a deliverable).

## Host

This runs on a **shared** Hetzner VPS (Ubuntu 26.04 "resolute"), not a dedicated box. Other
production services already live here (a Node app behind Caddy on `autovidgen.duckdns.org`,
reverse-proxied on ports 3000/8443/8444). Do not assume exclusive use of ports, Caddy config, or
system resources — always check what's running before touching shared files like
`/etc/caddy/Caddyfile`.

- Docker was not installed before this project; installed via Docker's official apt repo
  (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-compose-plugin`) on 2026-08-04.
  `deploy` user was added to the `docker` group but commands in this doc use `sudo docker`
  since that's what was verified working end-to-end.
- Host port `3000` is already taken by another app — PLANKA is bound to `127.0.0.1:3001` for
  now (not exposed externally). This will change once real domain + Caddy wiring happens.
- A pending kernel upgrade was flagged during `apt install` (running `7.0.0-15-generic`, staged
  `7.0.0-28-generic`). Not applied — a host reboot is a shared-infra risk and needs explicit
  go-ahead, not something to do silently mid-deployment.

## Versions pinned (verified live against the repo on 2026-08-04, not from training data)

- PLANKA: `ghcr.io/plankanban/planka:2.1.1` (latest stable tag as of verification date)
- Postgres: `postgres:16-alpine` (matches upstream's own `docker-compose.yml` pin)
- Never use `:latest` for either — upstream's own compose file pins Postgres but *not* PLANKA
  itself (`ghcr.io/plankanban/planka:latest` in their sample); we override to the explicit tag.

## What's deployed so far (Phase 1, in progress)

- `docker-compose.yml` — our production compose file, adapted from upstream's `2.1.1` tag with:
  - Image pinned (see above, upstream doesn't pin its own image)
  - `restart: unless-stopped` instead of upstream's `on-failure` (needed for reboot survival —
    `on-failure` won't restart a cleanly-exited container)
  - Postgres hardened with a real generated password instead of upstream's default
    `POSTGRES_HOST_AUTH_METHOD=trust` (defense in depth; Postgres isn't published to the host
    either way, only reachable inside the compose network)
  - `deploy.resources.limits` on both services (1.5 CPU/1.5GB planka, 1 CPU/1GB postgres) —
    added specifically because this is a shared box; no official PLANKA sizing guidance exists
    (confirmed absent from docs as of verification date), these numbers are a conservative
    engineering estimate for ~100 non-concurrent staff, not an official recommendation. Watch
    actual usage and adjust.
  - `TRUST_PROXY=true` set in advance for when Caddy fronts it (harmless without a proxy)
  - `DEFAULT_ADMIN_*` vars seed the bootstrap admin account. **Rotate or remove these once OIDC
    (Phase 2) is wired up and is the primary login path** — an admin account with a static
    password from `.env` should not be the permanent auth model for 100 users.
- `.env` — real secrets (`SECRET_KEY` via `openssl rand -hex 64`, `POSTGRES_PASSWORD` via
  `openssl rand -hex 32`), gitignored. `.env.example` has dummy values, is committed.
- `BASE_URL` is currently `http://localhost:3001` — a **placeholder**. Must be updated to the
  real domain (`https://<real-domain>`) and the stack restarted before this goes live or before
  OIDC redirect URIs are configured, since PLANKA derives callback URLs from `BASE_URL`.

## Verified, not just assumed (2026-08-04)

Per the brief's "verify before you build" rule, the following were confirmed against the live
running container, not the docs alone:
- `docker compose down && up` cycle: clean, app returns HTTP 200 within ~6s of container start.
- Full auth flow works end-to-end via the real API: register/login → `E_FORBIDDEN` +
  `pendingToken` (terms-acceptance step, not documented in `.env.sample`) → `GET /api/terms` for
  the signature → `POST /api/access-tokens/accept-terms` → real access token.
- Created a real project → board → list → card via the API, then confirmed
  `GET /cards/{id}/actions` returns `createCard` and `moveCard` (with `fromList`/`toList`
  including list name and type) exactly as the API source suggested. **This is the data source
  Phase 4's cycle-time collector will use** — confirmed live, not just from reading the
  controller source.
- Resource limits (`deploy.resources.limits`) are honored by plain `docker compose up` on
  Compose v5.4.0 without Swarm mode — confirmed via `docker inspect` showing the limits applied
  and the app still starting cleanly under them.
- Test project/board/list/card were deleted after verification — the instance is clean.

## Not yet done (remaining Phase 1 gate items)

- **Reverse proxy / TLS**: blocked on the real domain (client hasn't provided one yet). Caddy is
  already running on this host for another product — adding a PLANKA site block means editing
  shared `/etc/caddy/Caddyfile`, which needs explicit confirmation before touching (per the
  brief's ground rules) since a config error could take down the other product's routing too.
- **Host reboot test**: restart policy (`unless-stopped`) + `docker` enabled at boot
  (`systemctl is-enabled docker` → `enabled`) means containers *should* come back after a real
  reboot, but this hasn't been tested with an actual reboot — that's disruptive on a shared box
  and needs sign-off first, not just Docker's documented behavior taken on faith.
- Admin bootstrap credential (`DEFAULT_ADMIN_PASSWORD` in `.env`) has not been rotated out of a
  human-readable value — fine for now since only the operator has host access, but flag this
  before handover.

## Licensing

Confirmed via live read of `LICENSE.md` and `LICENSES/PLANKA License Guide EN.md` on 2026-08-04:
self-hosting for ~100 employees of one organization, on that organization's own server, with no
resale/third-party hosting, falls under the free Fair Use License — explicitly named as an
allowed example ("internally within your own organization"). No seat cap in the license text.
