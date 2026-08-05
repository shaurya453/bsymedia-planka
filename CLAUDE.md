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
- Host port `3000` is already taken by another app — PLANKA is bound to `127.0.0.1:3001`,
  fronted by Caddy (see Domain/TLS section below), never exposed directly on a public port.
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
- `BASE_URL=https://bsymedia.duckdns.org` — real, live.

## Domain / TLS (2026-08-04)

- Domain: `bsymedia.duckdns.org`, a free DuckDNS subdomain the client/contractor already
  controls (same DuckDNS account as `autovidgen.duckdns.org`, which is a *different, unrelated*
  product on this same box — one DuckDNS account, multiple independent subdomains, each can
  point anywhere; both currently point at this host's IP `167.233.63.45`).
- **This is a placeholder-quality domain, not a final decision.** DuckDNS is free and fine for
  getting unblocked, but a client-facing production tool for ~100 staff would normally get a
  real domain/subdomain the client owns outright (e.g. `planka.clientdomain.com`) rather than a
  third-party dynamic-DNS service. Revisit before calling this "done" — migrating later just
  means: point new DNS at `167.233.63.45`, add a new Caddy block, update `BASE_URL`, restart.
- Caddy automatically provisions/renews TLS for the domain (Let's Encrypt, `tls-alpn-01`
  challenge — confirmed via `journalctl -u caddy`, cert obtained in ~7s). No manual cert
  management needed.
- **Keep-alive**: DuckDNS doesn't auto-track IP changes; the box's IP must be re-pushed
  periodically. A cron job (`*/5 * * * * /home/deploy/planka/scripts/duckdns-update.sh`) does
  this, reading the token from `/home/deploy/planka/.secrets/duckdns.env` (chmod 600,
  gitignored). This **deliberately duplicates** an existing, near-identical script already
  running for the other product (`/home/deploy/portal/scripts/duckdns-update.sh`) — same
  DuckDNS account/token family, but kept as separate scripts/cron entries/secrets files per
  project so PLANKA stays self-contained and portable if handed to a different maintainer or
  moved off this box later. Do not consolidate them without deliberately deciding to couple the
  two projects.
- `/etc/caddy/Caddyfile` is **shared** with the other product. PLANKA's block was *appended*,
  nothing else was touched. A timestamped backup was taken before editing
  (`/etc/caddy/Caddyfile.bak-<timestamp>`). Applied via `caddy validate` (passed) then
  `systemctl reload caddy` (graceful — doesn't drop the other product's connections), not
  `restart`. Verified both domains independently afterward.

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
- Repeated the full auth-flow + authenticated API verification a second time through the real
  public HTTPS domain (`https://bsymedia.duckdns.org`) after Caddy/TLS was wired up — not just
  against `127.0.0.1` — to confirm the proxy hop doesn't break anything (cookies, redirects,
  `TRUST_PROXY` behavior).

## Not yet done (remaining Phase 1 gate items)

- **Host reboot test**: restart policy (`unless-stopped`) + `docker` enabled at boot
  (`systemctl is-enabled docker` → `enabled`) means containers *should* come back after a real
  reboot, but this hasn't been tested with an actual reboot — that's disruptive on a shared box
  and needs sign-off first, not just Docker's documented behavior taken on faith.
- Admin bootstrap credential (`DEFAULT_ADMIN_PASSWORD` in `.env`) has not been rotated out of a
  human-readable value — fine for now since only the operator has host access, but flag this
  before handover.

## Invite service (replaces Phase 2's original OIDC plan)

**Why this exists instead of SSO**: the original plan (Phase 2) was Google Workspace OIDC. The
client confirmed BSY Media has no real Google Workspace — staff use personal Gmail accounts only
— which rules out domain-restricted login, group-claim role mapping, and org-level offboarding.
Instead we built an **invite-and-activate flow**: an admin invites someone by email + role +
board from a small internal tool; the invitee gets an emailed one-time link, sets their own
password, and lands in PLANKA with a real account. This is a custom-built service — PLANKA has
no native support for it — living at `invite-service/`, deployed as its own container.

### Design decisions

- **v1 is admin-only**, not delegated to project managers. PLANKA's own permission model
  requires instance-admin (`role: 'admin'`) to call `POST /api/users` at all — there's no
  project-manager-scoped "create user" capability to delegate into, so PM-level self-service
  invites are not currently possible without either giving PMs admin (too broad) or building a
  privilege-escalation layer (out of scope for v1).
- **Invited users always get PLANKA's `boardUser` instance role.** The role picker in the invite
  form controls *board-level* role (`editor`/`viewer` on the specific board being invited to),
  not the instance-wide role. This matches what the brief actually asked for (per-board access
  control) — nobody gets instance-admin through this flow.
- **Dedicated service account** (`PLANKA_SERVICE_EMAIL` / `PLANKA_SERVICE_PASSWORD` in `.env`,
  `invite-service@planka.local`, role `admin`) is what actually creates the account and board
  membership when someone completes an invite — not the inviting admin's own session. The
  accept-flow is intentionally unauthenticated (the invitee has no PLANKA session yet), so it
  can't depend on the original admin still being logged in.
- **Caddy mounts this at `/invite/*`** on the same public domain (`bsymedia.duckdns.org`),
  stripping the prefix before proxying to the container. Every server-side redirect in
  `index.js` re-adds the `/invite` prefix via a `BASE_PATH` constant — Express's own view of its
  routes has no prefix, so a bare `res.redirect('/')` would resolve against the domain root
  (PLANKA itself), not this service. **Trailing slash matters**: Caddy's `handle_path /invite/*`
  only matches with a trailing slash; `/invite` alone falls through to the next block's
  catch-all `reverse_proxy` (PLANKA), which confusingly returns HTTP 200 (PLANKA's SPA serves
  `index.html` for any unmatched path) — makes the bug look like a false success under a naive
  test. Caught via `curl .../invite` (200, wrong app) vs `curl .../invite/` (302, correct) during
  build; fixed by using `` `${BASE_PATH}/` `` specifically on the post-login redirect.
- **Sessions are Postgres-backed** (`connect-pg-simple` against a dedicated `planka_ops`
  database, separate from PLANKA's own `planka` database — created idempotently on startup via
  `pg_database` existence check, since Postgres has no `CREATE DATABASE IF NOT EXISTS`), not
  in-memory — survives container restarts, avoids a second stateful dependency (e.g. Redis).
- **Invite tokens**: `crypto.randomBytes(32)`, SHA-256 hashed before storage (raw token only
  ever exists in the emailed URL and briefly in memory — DB compromise doesn't leak usable
  tokens), single-use (`used_at` checked), 7-day expiry.
- **CSRF protection**: session-bound random token + `crypto.timingSafeEqual` comparison on every
  POST (login, send, accept).

### Email delivery (Gmail SMTP)

- `mailer.js` uses Nodemailer against Gmail. **Do not use the `service: 'gmail'` shorthand** —
  it defaults to port 465 (implicit TLS), which this host's outbound firewall blocks (confirmed
  via a raw `net.createConnection` test: 465 → `ETIMEDOUT`, 587 → connects immediately). Use
  explicit `host: 'smtp.gmail.com', port: 587, secure: false` (STARTTLS) instead.
- Explicit `connectionTimeout`/`greetingTimeout`/`socketTimeout` (10s each) are set deliberately
  — without them, a bad account/blocked port hangs the request indefinitely instead of failing
  back to the admin with a visible error.
- Sending identity is one fixed mailbox for the whole service (`GMAIL_USER` /
  `GMAIL_APP_PASSWORD` in `.env`, currently `admin@bsymedia.com` with a Google App Password —
  requires 2-Step Verification on that account). This is **independent of PLANKA login
  credentials** — same email can be both the SMTP sending identity and a human's PLANKA admin
  login, with two unrelated passwords, since one is a Google-account credential and the other is
  a password hash inside PLANKA's own database. The admin who's logged into the invite tool at
  send-time (`inviterEmail`) only appears in the email body copy, never in the SMTP envelope/
  From header.
- Verified end-to-end on 2026-08-05: real invite sent via live Gmail SMTP through the public
  domain, no errors in `docker compose logs invite-service`, confirmed via the `success=` query
  param on redirect. Test project/board and test invite-DB rows were deleted afterward (see
  "Verified" section below) — instance holds 0 projects and exactly the 2 real accounts
  (bootstrap admin, invite-service) as of last check.

### Compose / env additions

- New service `invite-service` in `docker-compose.yml`: built from `./invite-service`, bound to
  `127.0.0.1:3002:3000`, resource limits 0.5 CPU / 256MB (small — session store + a few HTTP
  routes, not a persistent workload), depends on `postgres` (healthy) and `planka` (started).
- New `.env` keys: `PUBLIC_URL`, `PLANKA_PUBLIC_URL`, `PLANKA_INTERNAL_URL`
  (`http://planka:1337`, container-to-container), `SESSION_SECRET`, `OPS_DATABASE_URL`,
  `PLANKA_SERVICE_EMAIL`/`PASSWORD`, `GMAIL_USER`/`GMAIL_APP_PASSWORD`.

## Backups (Phase 5, 2026-08-05)

- **Local-only, by deliberate choice.** Client was offered Hetzner Storage Box, an S3-compatible
  bucket, or Google Drive; Google Drive turned out to require real setup friction — confirmed
  live against rclone's own docs that rclone's shared Google API client_id is being retired
  during 2026, so Drive now needs a self-created Google Cloud project, a custom OAuth client
  (Desktop app type), a configured consent screen, and a one-time interactive browser
  authorization — none of which can be done on the client's behalf without their own Google Cloud
  Console access. Service accounts (which would skip the browser step) only get usable Drive
  storage on a real Google Workspace domain, which BSY Media doesn't have (see Invite service
  section above) — so that shortcut doesn't apply either. Given that friction, client chose
  local-only for now. **This does not protect against the VPS or its disk failing** — only
  against accidental deletion/corruption inside PLANKA itself. Revisit an offsite target later.
- `scripts/backup.sh` — dumps both Postgres databases (`planka`, and `planka_ops` which holds
  invite-service state) via `pg_dump` over the container's local Unix socket (confirmed: no
  password needed for local-socket connections even though `POSTGRES_PASSWORD` is set and
  required for TCP — Postgres's default `pg_hba.conf` only enforces password auth on `host`
  entries, not `local`), gzips them, and tars the `planka_data` volume (PLANKA's uploaded
  attachments) via a disposable `alpine:3.22` container with the volume mounted read-only —
  avoids needing the volume's on-disk path to be reachable from the host filesystem directly.
  Output lands in timestamped directories under `/home/deploy/planka-backups/`, **deliberately
  kept outside this git repo entirely** (not just gitignored) so a `git add -A` mistake can never
  stage a dump full of real user data. Retention: 14 days, pruned automatically each run.
  Idempotent/safe to re-run anytime (new timestamped dir each time, no shared state to corrupt).
- Logs to `logs/backup.log` (gitignored), matching the existing `duckdns-update.sh` pattern.
- Scheduled via cron, `0 3 * * *` (daily, 3am).
- **Restore drill performed, not just assumed working**: restored a real dump into a scratch
  `restore_drill` database inside the same running Postgres container (never touched the live
  `planka` database), then compared `user_account`/`project` row counts between live and restored
  — matched exactly. Scratch database dropped immediately after. This should be re-run
  periodically (e.g. after the Trello import lands real data) — a backup that's never been test-
  restored isn't a verified backup, and today's drill only proves the pipeline works on today's
  near-empty dataset.
- **Not yet covered by this backup**: the `invite-service` container image/build context (fine —
  it's in git) and the host-level Caddy config (`/etc/caddy/Caddyfile`, shared with the other
  product on this box — already gets its own timestamped `.bak` file on every edit, but isn't
  part of any recurring backup job).

## Licensing

Confirmed via live read of `LICENSE.md` and `LICENSES/PLANKA License Guide EN.md` on 2026-08-04:
self-hosting for ~100 employees of one organization, on that organization's own server, with no
resale/third-party hosting, falls under the free Fair Use License — explicitly named as an
allowed example ("internally within your own organization"). No seat cap in the license text.
