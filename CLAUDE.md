# PLANKA deployment — technical notes

For the client's own admin, see `RUNBOOK.md` (written as part of Phase 1 handover work). This
file is for whoever maintains the stack technically next.

## What this is

Self-hosted PLANKA (Trello-alternative) for ~100 internal staff of one organization, replacing
their Trello workspace for cost reasons. Deployed per the brief in `planka-start.md` (repo root's
parent — kept outside this repo since it's the contractor's working brief, not a deliverable).

## Roadmap (3 phases, per the brief's priority order)

The brief lists three deliverables in priority order — that's the canonical phase numbering for
this project (supersedes an earlier, more granular phase-1..6 breakdown used mid-build, whose
sub-parts now all live under Phase 1 below):

1. **Phase 1 — Stable, secured, backed-up instance.** Deployment, the invite-service (which
   replaced the original OIDC/SSO plan), backups, the in-app invite button, self-signup +
   batch-assign, and `RUNBOOK.md` handover all fall under this phase — see the dedicated sections
   below. In progress; see "Not yet done" for open gate items.
2. **Phase 2 — Trello migration.** Not started. See "Trello import" section below for the plan.
3. **Phase 3 — Cycle-time reporting.** Not started, blocked on one open decision: presentation
   format (dashboard vs. scheduled export vs. other) — see "Cycle-time reporting" section below.

**Outside this 3-phase brief scope**: a second source, Taiga, was consolidated into the same
instance on 2026-08-07 at the client's request — see "Taiga import" below. The generic import
machinery built for it is what Phase 2 (Trello) will reuse. Also outside scope: 5 UI/UX requests
(add-list button, share button, background theming/presets, terms banner) delivered 2026-08-07 —
see "UI/UX customizations: fork-and-build pipeline" below. That work replaced the
prebuilt-image-plus-view-patch approach with a real fork-and-build pipeline, which is now the
mechanism available for any future frontend change.

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
  - `DEFAULT_ADMIN_*` vars seed the bootstrap admin account. **Rotate or remove these once
    invite-service (see below) is fully the primary login path** — an admin account with a static
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
  Phase 3's cycle-time collector will use** — confirmed live, not just from reading the
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

## Invite service (Phase 1 — replaces the original OIDC/SSO sub-plan)

**Why this exists instead of SSO**: the original sub-plan was Google Workspace OIDC. The
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

### Self-signup link + batch-assign (2026-08-06)

Added because the one-invite-at-a-time flow above doesn't scale to onboarding 100+ staff. Two
new routes on the same `invite-service`, no new containers/infra:

- **`GET/POST /invite/join`** — public, unauthenticated, no gate (deliberate choice — this is an
  internal tool for BSY Media staff, not public-facing; client chose no passphrase/domain
  restriction). Visitor picks their own name/email/password; account is created via the
  `PLANKA_SERVICE_EMAIL` service account (same pattern as invite-accept) with `role: 'boardUser'`
  and **no board membership** — self-signup only creates the account, it does not grant access to
  anything. The admin invite page (`/invite/`) shows this link in a copyable box so it only needs
  to be shared once (e.g. in a company-wide message), instead of an admin sending 100 individual
  invite emails.
  - **Known trade-off, accepted deliberately**: since there's no gate, anyone who obtains the
    link can create a PLANKA account (with no project/board access) at any time — it's a
    standing-open door, not single-use like the emailed invite tokens. Acceptable for an internal
    tool; revisit (shared passphrase or `@bsymedia.com`-only email restriction, both trivial
    additions to the existing `/join` POST handler) if abuse ever becomes a real concern.
- **`GET/POST /invite/assign`** (admin-only, behind the same `requireAdmin` as `/invite/`) —
  multi-select checkboxes for users (fetched via `GET /api/users`, admins filtered out of the
  list) × boards (`GET /api/projects` included.boards, same helper `/invite/` already uses), one
  role applied to all selected pairs. Submit loops `POST /boards/:id/board-memberships` once per
  (user, board) pair server-side — **PLANKA has no batch membership endpoint**, confirmed by
  reading `board-memberships/create.js`: `userId` is a single required field, not an array.
  Per-pair failures (most commonly: already a member → 409) are counted and skipped rather than
  aborting the whole batch; the result page reports `Added N, skipped M`.
  - **PLANKA's access model is per-board, not per-project** — confirmed via `routes.js`: no
    `project-memberships` concept exists, only `board-memberships` and a separate
    `project-managers` relation (`POST /projects/:id/project-managers`, grants access to *every*
    board in that project — the closest thing to a project-level bulk grant, not used by this
    batch-assign screen, which stays at board granularity to match what `/invite/` already
    offers).
- **"Could not create your account: ...1 missing or invalid parameter" — investigated 2026-08-09,
  two causes closed, root cause for the reported incident NOT fully confirmed.** A real user hit
  this exact PLANKA API error, passed straight through verbatim by `invite-service`, naming no
  field and no fix. No log of their actual submitted values survived to confirm which rule they
  tripped — lost when this service's container was recreated while deploying the fix, a mistake
  worth remembering: **check logs for a live incident before restarting the service that logged
  it**, not after. Rather than guess at one cause, reproduced the exact error text against two
  independently plausible ones and closed both:
  - **Password strength**: PLANKA rejects passwords with `zxcvbn(value).score >= 2`
    (`utils/validators.js`'s `isPassword` custom validator), not just a length check — e.g.
    `password1234` clears an 8-char minimum but scores 1. A 2026-08-06 fix only added a hint under
    the field (*"Must be reasonably strong..."*), which doesn't stop someone who doesn't read it.
  - **Email format**: the signup form's email field (PLANKA client, 2026-08-06 patch) is a plain
    text input — no `type="email"`, no client-side format check — and `invite-service` itself only
    checked truthiness (`!email`), not shape, before this fix. Any malformed-but-non-empty string
    reached PLANKA's `isEmail: true` validator and produced the identical generic message.
  Both are now checked in `invite-service` itself, mirroring PLANKA's exact server-side rules
  (`zxcvbn` pinned to `4.4.2` to match the version actually bundled in the live PLANKA container,
  not just its own `package.json` range; `validator` pinned to `13.15.26` same reasoning) *before*
  ever calling PLANKA's API — either one is now caught with a specific, actionable message instead
  of a passthrough that can still slip through. `friendlyAccountCreationError()` added as defense
  in depth for any third, not-yet-seen validation rule. Verified live: malformed email and weak
  password each rejected instantly with their own clear message; a valid signup still creates a
  real account end-to-end (test account created via `/api/join`, then deleted). **Still open**: no
  proof either fix addresses what this specific user hit, since the evidence is gone — if it
  recurs, check `docker compose logs invite-service` *immediately*, before touching the container.
- **"Invalid or expired session - log into PLANKA again" persisting after a real re-login — fixed
  2026-08-09.** `admin@bsymedia.com` hit this using the Share modal's invite-by-email field
  (`POST /invite/api/send`, added by the 2026-08-07 `0011`/`0012` patches — Bearer-token auth
  using the caller's own PLANKA access token, no invite-service login involved at all, despite the
  message's wording). Root cause, found by reading the code (no surviving logs — lost again to an
  earlier container recreation, see above): the catch block around `planka.getMe(token)` blamed
  "your session" for *any* failure verifying the token — a genuinely expired/invalid one (real
  401), but also a network hiccup reaching PLANKA, or PLANKA returning any other error status —
  and re-logging in obviously can't fix a cause that was never about the session. Fixed to only
  show that message for an actual confirmed 401 from PLANKA (`error instanceof
  planka.PlankaApiError && error.status === 401`); anything else now returns a 502 with a message
  that says a server issue, not the user's login, is likely at fault, plus a `console.error` log
  line so a future occurrence is actually diagnosable. **Verified both branches directly**: a
  garbage token still correctly triggers the session message (confirmed real PLANKA 401), while a
  simulated PLANKA-unreachable case (temporarily pointing `PLANKA_INTERNAL_URL` at a closed port
  in an isolated `node -e` check, not the live service) confirms a connection failure is a plain
  `TypeError`, not a `PlankaApiError` — proving it correctly falls into the new, non-misleading
  branch instead of blaming the session.
- Verified end-to-end on 2026-08-06 against the live site: self-signup created a real account via
  `/invite/join`, batch-assign added that account to a temporary test board via `/invite/assign`
  (confirmed via `GET /api/boards/:id` showing the new `boardMemberships` row), then all test
  artifacts (project, board, test user) were deleted — instance back to 0 projects / 3 real
  accounts (bootstrap admin, invite-service, `admin@bsymedia.com`) as of last check.

## Source code backup (2026-08-09)

This repo (`/home/deploy/planka`) has been a real local git repo since the board-creation-modal
work, but had no remote — every commit only existed on this one VPS. The section below
("Backups") only protects *data* (DB + attachments); it says nothing about the custom source code
itself (patches, `invite-service`, `docker-compose.yml`). If the VPS were lost, the data would
survive via the offsite Mega copy, but every custom feature built on top of stock PLANKA would
have to be redone from scratch.

Fixed by pushing this repo to a private GitHub repo, `https://github.com/shaurya453/bsymedia-planka`,
over a **dedicated SSH deploy key** (not a personal access token) — scoped to write access on just
this one repo, nothing else on the account:
- Key: `~/.ssh/planka_deploy_key` (ed25519, deploy user, no passphrase, chmod 600 dir).
- `~/.ssh/config` has a `Host github.com-planka` alias pointing at it with `IdentitiesOnly yes`,
  so it doesn't collide with any other GitHub key that might get added later.
- Remote: `origin` → `git@github.com-planka:shaurya453/bsymedia-planka.git`, branch `main`.

**This does not auto-push.** Future commits in this repo stay local-only until someone runs
`git push`. If ongoing hands-off protection matters, consider a cron/post-commit hook — not set up
as of 2026-08-09, since commits here happen in bursts during active work sessions, not
continuously.

## Backups (Phase 1, 2026-08-05; offsite added 2026-08-09)

- **Offsite copy added 2026-08-09, via rclone to Mega, encrypted client-side.** Originally shipped
  local-only since Google Drive specifically needed real setup friction — confirmed live against
  rclone's own docs that rclone's shared Google API client_id is being
  retired during 2026, so Drive needs a self-created Google Cloud project, custom OAuth client,
  consent screen, and one-time browser authorization. Revisited when the client wanted this gap
  closed without that ceremony: **Mega** needs no OAuth app at all (rclone's `mega` backend just
  takes an account email/password), has a 20GB free tier, and the *entire* local backup set
  (263.9MB as of last check) uses under 2% of it. Two rclone remotes configured under
  `deploy`'s own `~/.config/rclone/rclone.conf` (chmod 600, outside git):
  - `megaremote` — the raw Mega account (`admin@bsymedia.com`).
  - `cryptremote` — a `crypt` remote wrapping `megaremote:planka-backups`, encrypting both
    filenames and file contents client-side before upload. Confirmed live: the raw Mega listing
    (`rclone lsf megaremote:planka-backups/`) shows only a scrambled directory name, while
    `rclone lsf cryptremote:...` shows real filenames — encryption is actually happening, not
    just configured. **The crypt passphrase only exists in `rclone.conf` (obscured, not
    plaintext) and was shown to the operator once at generation time** — if this VPS and that
    passphrase are both lost, the offsite copies are permanently unreadable. Not this repo's
    problem to solve further (it's out of `rclone.conf`'s own control), but worth restating: this
    passphrase must live in a password manager, not just on this box.
  - `scripts/backup.sh`'s last step runs `rclone sync "$BACKUP_ROOT" cryptremote:planka-backups`
    (see below for why `sync` specifically) after the local dump+prune succeeds, non-fatal (a
    network hiccup here doesn't fail the whole run — the local backup already landed by that
    point). Verified end-to-end 2026-08-09: full manual run synced all 6 existing local backup
    dirs offsite correctly, and a restore drill (download one `planka.sql.gz` off Mega through
    `cryptremote:`, `gunzip -t`, inspect contents) confirmed a valid, intact dump.
- **Why `sync` and not `copy`**: mirrors local's retention exactly — when the 14-day prune below
  deletes an old local backup directory, the next `rclone sync` deletes it offsite too. No
  separate remote-side retention job to build or maintain; the offsite copy is always "whatever's
  currently in `$BACKUP_ROOT` locally," nothing more, nothing less.
- The rest of this section (below) predates the offsite copy and still accurately describes the
  local side (`scripts/backup.sh`'s dump/tar/retention logic, its cron schedule, the original
  local restore drill) — only its old closing claim, "this does not protect against the VPS or
  its disk failing," is now out of date: the offsite Mega copy specifically closes that gap.
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

## Attachment upload limit (2026-08-09)

Client reported a ~1MB attachment ceiling, easily hit by screenshots. **Investigated by reading
the actual live code inside the running container** (`server/config/custom.js`'s
`maxUploadFileSize`, `server/api/helpers/utils/receive-file.js`, and `getAvailableStorage.js`,
which reads a DB-stored `InternalConfig.storageLimit` row) rather than assumed — confirmed neither
`MAX_UPLOAD_FILE_SIZE` nor the DB storage-limit row were set, and traced the fallback all the way
into the installed `skipper-disk` package's own null-safety (`!_.isNull(options.maxBytes)` guard
in `build-progress-stream.js`) to confirm an unset limit is genuinely uncapped here, not some
hidden small default. **Empirically verified this with a real multipart upload test against the
live API** (not just static reading) — files up to 20MB uploaded successfully with the
then-current config, meaning no server-side cap was actually active at time of investigation.

Fixed anyway, to make the policy explicit rather than relying on an implicit "unset = uncapped"
behavior: `MAX_UPLOAD_FILE_SIZE=50MB` added to both `.env` and `.env.example`.

**Real gotcha hit while wiring this in, worth remembering for any future new `.env` var**:
`docker-compose.yml`'s `planka` service does *not* use `env_file: .env` — it explicitly whitelists
individual vars under `environment:` (`BASE_URL`, `DATABASE_URL`, `SECRET_KEY`,
`DEFAULT_ADMIN_*`, etc.). Adding a value to `.env` alone does nothing; it also has to be added as
its own `- MAX_UPLOAD_FILE_SIZE=${MAX_UPLOAD_FILE_SIZE}` line in that block, or the container never
sees it (confirmed via `docker compose exec planka sh -c 'echo $MAX_UPLOAD_FILE_SIZE'` printing
empty even after a `--force-recreate` restart, until the `environment:` line was added). Any
future new env var needs both edits, not just `.env`.

## In-app "Invite users" button (Phase 1, 2026-08-05)

Admins asked for a way to reach the invite tool without remembering/typing `/invite/` by hand.
PLANKA has **no native customization hook** for this — confirmed against live source
(`config/custom.js`, `api/`) that there's no custom-menu/custom-link/custom-HTML setting to hook
into. Patching the compiled React bundle (`/app/public/assets/*.js`, hashed/minified filenames
that change every version) to add a real nav-bar item would be fragile reverse-engineering, so at
the time this was built: `planka-custom/` was a thin wrapper `Dockerfile` (`FROM
ghcr.io/plankanban/planka:2.1.1`) that patches only `/app/views/index.ejs` — the small
server-rendered HTML shell, not the JS bundle — inserting a floating "Invite users" link
(`planka-custom/invite-button.html`) that opens `/invite/` in a new tab. `docker-compose.yml`'s
`planka` service built this instead of pulling the image directly (`build: ./planka-custom` in
place of `image: ghcr.io/...`) — version pin was preserved, just one layer removed.

**Superseded 2026-08-07** — see "UI/UX customizations: fork-and-build pipeline" below.
`planka-custom/` now builds PLANKA from its own source instead of patching the prebuilt image,
so real bundle changes are no longer off the table. This invite-button step itself didn't need to
change (still just an `index.ejs` sed patch, now applied as the last step of a from-source build
instead of on top of a pulled image) — kept as-is rather than converted to a "real" React
component, since it already works and touching it wasn't part of that request.

- Upstream's image runs as the non-root `node` user; the patch step needs `USER root` (to write
  `/app/views/index.ejs` and clean up `/tmp`), then switches back to `USER node` before the image
  is done, so the container still runs unprivileged at runtime as upstream intends.
- **Shown to everyone, not just admins** — deliberate simplicity trade-off. PLANKA's frontend
  doesn't expose the logged-in user's role in an easily-readable way from a static HTML injection
  (its access token/role state lives in `localStorage` under a dynamically-minified key name;
  chasing that down would mean parsing the compiled bundle and re-verifying it on every PLANKA
  update — not worth it for a small unobtrusive button). Non-admin staff who click it just hit
  invite-service's existing "Only PLANKA admins can send invites" message — harmless, not broken.
- Verified live: PLANKA still returns HTTP 200 after the rebuild, and the button's HTML is
  confirmed present in the actual served page (not just "the build succeeded").
- On every future PLANKA version bump: re-check that `/app/views/index.ejs` still contains the
  `<div id="root"></div>` line the `sed` insertion anchors on — if upstream changes that template,
  the patch silently no-ops (PLANKA still works fine, the button just won't appear) rather than
  breaking the build, so it's easy to miss without a manual check.

## UI/UX customizations: fork-and-build pipeline (2026-08-07)

Client asked for 5 UI/UX changes: an "Add another list" button, a "Share" button on the board
navbar, customizable board/cover backgrounds with preset images and automatic dark/light card
theming, and removal of the "THIS IS ONLY A TEMPLATE" banner from the End User Terms shown at
login. Researched the actual v2.1.1 source (cloned `github.com/plankanban/planka` at tag `2.1.1`
— confirmed byte-for-byte version match against `package.json` in the running container) before
writing anything, rather than assuming from memory or from upstream's general Trello-like
reputation.

**Most of this was already native** — the real gap was that this deployment had no way to ship
*any* real frontend source change yet (see "In-app Invite users button" above: deliberately
avoided touching the compiled bundle). So this work has two parts: (1) a new build pipeline that
can ship real source patches, and (2) the actual small patches once that existed.

### What turned out to already exist (no new code)

- **Add list**: `AddList.jsx` already existed, already correctly gated to board `editor`s. It's
  also gated behind a client-side "Edit Mode" lock toggle in the header
  (`client/src/reducers/core.js`, defaulted `false`) — that's why editors couldn't find it.
- **Board backgrounds**: gradients (25 built-in presets) and uploaded custom images were both
  already fully supported per-project (`Project.backgroundType`/`backgroundGradient`/
  `backgroundImageId`).
- **Card covers**: already supported (`Card.coverAttachmentId` — any attachment can be set as a
  card's cover).
- **Board membership management** ("Share"): full member list, role-change, and add-member flow
  already existed (`BoardMemberships.jsx` → `AddStep.jsx`/`ActionsStep.jsx`), wired to real
  endpoints. It was just an unlabeled icon button, and — this took a closer read than expected —
  **the "hidden on a board with zero members" concern turned out not to be real**: a project
  manager already sees the widget on an empty board via the `selectIsCurrentUserManagerForCurrentBoard`
  fallback in `BoardActions.jsx`. No permission-gating code was touched.
- **Terms/license customization**: PLANKA already ships a built-in override — `TERMS_TYPE` env
  var (defaults to `custom`) makes the `terms` hook look for `/app/terms/custom/<lang>.md`; since
  that path didn't exist, it silently fell back (with a log warning) to
  `/app/terms/_template/<lang>.md`, the file with the "⚠️ THIS IS ONLY A TEMPLATE" banner. Fixed
  with **zero React/source changes** — just shipping a `terms/custom/en-US.md` file.

### The build pipeline (prerequisite for the rest)

`planka-custom/Dockerfile` no longer pulls `ghcr.io/plankanban/planka:2.1.1`. It now clones
`github.com/plankanban/planka` at tag `2.1.1` in a dedicated `source` stage, applies
`planka-custom/patches/*.patch` via `git apply --binary`, then runs upstream's own unmodified
3-stage build (server build → client build with `INDEX_FORMAT=ejs` → final image assembly),
mirrored line-for-line from upstream's own `Dockerfile`. The existing `invite-button.html` sed
step and the new `terms/custom` `COPY` both run as the last steps of the final stage, same as
before. `docker-compose.yml` needed no changes (`build: ./planka-custom` already pointed here).

**Tradeoff accepted deliberately**: this is real supply-chain surface we didn't have before —
previously running the vendor's own published, signed image; now building from source ourselves.
On every future PLANKA version bump: bump `PLANKA_VERSION` in the Dockerfile, run
`git apply --check patches/*.patch` against the new tag *before* changing anything else, and
re-diff/rebase any patch that no longer applies cleanly — don't assume a patch that applied
against 2.1.1 still applies as-is.

### The patch set (`planka-custom/patches/`, one concern per file)

1. `0001-locale-additions.patch` — two new `en-US` translation keys (`action.shareBoard`,
   `common.presets`).
2. `0002-edit-mode-default-on.patch` — `client/src/reducers/core.js`: `isEditModeEnabled`
   default flipped to `true`. Removes the extra lock-icon click standing between editors and
   "Add another list" (and drag/drop) — existing role/permission checks are untouched, so viewers
   still can't edit anything.
3. `0003-share-button.patch` — `BoardMemberships.jsx` gets a real "Share" label instead of a bare
   icon (`BoardMemberships.module.scss` widened from a 36px circle to a pill to fit the text);
   `AddStep.jsx`'s member picker now filters out `role === 'admin'` accounts. Confirmed live this
   excludes exactly `admin@planka.local` and `invite-service@planka.local` (both `role: admin`) —
   **but also excludes any other admin-role human account** (there's a third one live,
   `admin@bsymedia.com`) from being addable via this picker. Not fixed further since PLANKA has no
   "system account" flag to distinguish bot accounts from human admins — flagging this as a known
   sharp edge, not a bug, since admins already have broader access through other means. No
   backend/permission change — add-member stays gated to project managers server-side, as decided.
4. `0004-smart-background-theme.patch` — new light/dark background detection: gradients are
   classified ahead of time in `constants/BackgroundGradientLightness.js` (perceived-luminance
   formula run once by hand against each gradient's fixed CSS color stops — see the patch file for
   the actual numbers); uploaded images are sampled at runtime via canvas averaging
   (`utils/get-background-lightness.js`). **Scoped to the header and the "Add list" button, not
   card text** — verified list `.wrapper` backgrounds are opaque (`#dfe3e6`), so cards never
   actually sit on the raw project background; the header and "Add list" button do (both render
   with a semi-transparent black scrim directly over it), so that's where contrast actually
   breaks on light backgrounds. `ProjectBackground.jsx` toggles a `body.theme-light-bg` class;
   `Header.module.scss`/`KanbanContent.module.scss` darken their scrim when it's present.
5. `0005-preset-background-gallery.patch` — a "Presets" tab in `BackgroundPane.jsx` (now the
   default tab for projects with no background set yet) showing 8 bundled images
   (`client/src/assets/images/background-presets/`); clicking one uploads it into the project via
   the same `createBackgroundImageInCurrentProject` action a manual upload uses — not a separate
   storage mechanism. **The images are generic stock photos from picsum.photos/Unsplash (CC0),
   not BSY Media brand assets** — client explicitly asked for "generic high quality" over
   client-provided ones this round; swap the files in that directory and re-diff the patch if
   branded presets are wanted later. Card covers were left alone — they're per-card attachments,
   not a good fit for a generic preset gallery.

### Verified 2026-08-07

- All 5 patches apply cleanly (`git apply --check`) against a fresh `2.1.1` clone.
- `docker compose build planka` succeeded with no errors from either build stage.
- Compiled output confirmed to contain all 5 changes (`isEditModeEnabled:!0` in the JS bundle,
  the `shareBoard`/`presets` strings, the 8 preset JPEGs under `/app/public/assets/`, the
  `theme-light-bg` CSS rule).
- `GET /api/terms` confirmed banner-free; the terms-acceptance flow (new signature → forces
  re-acceptance, as expected since the content changed) tested end-to-end via the API.
- Regression-checked post-rebuild: the existing Taiga-imported board data is intact (180 cards /
  17 lists / 57 attachments, unchanged), and the invite-service floating button still renders.
- **Not verified**: the actual click-through UI behavior (Add List appearing without an extra
  toggle, Share button placement, preset gallery upload flow, visual contrast on a light vs. dark
  background) — no browser automation tool was available in this session. Do a quick manual pass
  before considering this fully done.

## Card sidebar/checklists/dates/activity-log overhaul (2026-08-10)

Four related card-detail upgrades requested together, closer to Trello's card UX: (1) sidebar
shows assigned members directly instead of a redundant "List" section, (2) a dedicated
"Checklists" tab alongside Comments/Actions, (3) start + due dates on both cards and checklists,
(4) every checklist/date action logged to the card's Actions tab.

**Most of the underlying data model already existed** — this was mostly wiring PLANKA's own
`TaskList`/`Task` primitives into a new layout, not building from scratch. Checklists are
`TaskList` (checklist) → `Task` (checkable item), a flat 2-level structure — no 3rd nesting level
was added. Card `dueDate`/`isDueCompleted` already existed with a working popup and status chip;
`startDate` did not exist anywhere (card or checklist) and needed new migrations
(`20260810120000_add_start_date_to_card.js`, `20260810120001_add_dates_to_task_list.js`).

- **Sidebar**: `ProjectContent.jsx`/`StoryContent.jsx`'s "List" section (list name + move-to-list
  dropdown) removed — list-move stays reachable via drag-and-drop and the "More Actions → Move"
  option (patch 0016). Replaced with an always-visible "Assigned Members" block reusing the
  existing `BoardMembershipsPopup`/`UserAvatar` — no new server model, `CardMembership` untouched.
- **Checklists tab**: `Communication.jsx`'s existing Comments/Actions `Tab` (Semantic UI) gained a
  third "Checklists" pane rendering `TaskLists` (moved out of its old always-inline spot under
  Description). Board-editor gating and card-face progress bars (`Card/TaskList/TaskList.jsx`)
  were untouched — separate component tree from the modal, confirmed live.
- **Dates**: `EditDueDateStep.jsx` extended in place into a combined "Dates" popup (Start + Due in
  one save), parameterized by `cardId` **or** `taskListId` so the same component drives both card-
  level dates (sidebar "Dates" button, renamed from "Due Date") and checklist-level dates (new
  calendar-icon button next to each checklist's rename pencil in `TaskLists/Item.jsx`). Checklist
  dates are modal-only by design (not on the Kanban card face) to avoid clutter on cards with
  several checklists. `TaskList` dates are stored as raw ISO strings client-side (no
  transform-at-fetch layer exists for task-lists the way `api/cards.js` has one for cards) and
  parsed to `Date` only where displayed/edited.
- **Activity log**: `Action.Types` gained `CREATE_TASK_LIST`/`UPDATE_TASK_LIST`/`DELETE_TASK_LIST`,
  `CREATE_TASK`/`DELETE_TASK`, `SET_CARD_START_DATE`/`SET_CARD_DUE_DATE` (task
  complete/uncomplete already existed). Task-list create/update/delete helpers previously sent
  webhooks but never called `sails.helpers.actions.createOne` — checklist activity was invisible
  before this change. Change-detection compares post-update DB records (not raw input values) to
  avoid false positives from a same-value resubmit or a Date-vs-ISO-string type mismatch.

### Deployed and verified live 2026-08-10

`docker compose build planka && up -d` — migrations ran automatically on boot, `start_date`/
`due_date`/`is_due_completed` confirmed present on both `card` and `task_list` tables. Screenshotted
live on a real card via Puppeteer: sidebar shows Members (no List section); Comments/Checklists/
Actions tabs all present; the combined Dates popup opens, saves both fields in one call, and
displays correctly; the Actions tab shows real "set the start/due date" log entries next to
pre-existing (unaffected) history. Patch: `planka-custom/patches/0021-checklists-dates-assigned-members.patch`.

**Incident during verification, self-corrected**: a browser-automation script mistyped into the
card name field instead of a checklist-item field, briefly renaming a real production card
("Most Disturbing Undertale Horror Games..." → had "First test item" prepended). Caught
immediately by comparing before/after DB state, fixed via a direct SQL `UPDATE` restoring the
original title (confirmed with the user before running it), and the test start/due dates set
during verification were cleared the same way. No other data was affected — checklist creation
was never actually completed during the incident (the "Add Task List" click failed every attempt
due to the same field-targeting issue, so no stray `task_list` row was ever created). **Lesson**:
this deployment's boards mostly use PLANKA's `story` card type (Yapmaster Media's 180 cards are
all `story`), not `project` — Checklists/Dates trigger buttons only exist in `ProjectContent.jsx`'s
sidebar (matching the plan's scope), so hands-on testing needs a `project`-type card specifically;
plain-text automation scripts against a live production card carry real risk and should be
reserved for read-only checks or done with tightly-scoped selectors, not loose text-matching.
Live-testing actual checklist item creation/completion was consciously skipped after this — the
component is a straight relocation of PLANKA's own existing, previously-working `TaskLists` code,
not new logic, so the residual risk was judged low relative to the cost of another live test.

### Follow-up fixes (2026-08-10, same day)

Two gaps found by the client immediately after the above shipped:

1. **Checklists tab had no add button.** Moving `TaskLists` into its own tab (see above) didn't
   carry over an add-affordance — the only "Add Task List" trigger was (and still is) the
   sidebar's "Add to Card" button, so a card with zero checklists showed a dead-end blank pane
   when you opened the tab. Fixed by giving `TaskLists.jsx` itself a local `canAdd` check (mirrors
   `Comments.jsx`'s own local board-editor computation) and a "+ Add task list" button at the
   bottom of the pane, reusing the existing `AddTaskListStep` popup unchanged.
   Patch: `0022-add-checklist-button-in-tab.patch`.
2. **Members shown as bare circular avatars.** Client asked for a proper list instead — avatar
   circle followed by name, scrollable rather than wrapping the sidebar taller. New
   `CardModal/AssignedMembers/` component (`AssignedMembers.jsx` + `Item.jsx`, modeled directly on
   the board Share modal's existing `ShareModal/MembersList` avatar+name row pattern) replaces the
   old inline avatar-row markup in both `ProjectContent.jsx` and `StoryContent.jsx`. List caps at
   `max-height: 208px` (~5 rows) with `overflow-y: auto`; the "+ Add Member" trigger sits below it,
   still opening the same `BoardMembershipsPopup` used everywhere else for add/remove.
   Patch: `0023-members-list-with-names.patch`.

Both rebuilt, redeployed, and screenshotted live on real cards (one confirming the checklist add
button, one with 7 real members confirming the scrollable list actually scrolls).

### Third fix: Story-card face never rendered checklists at all (2026-08-10)

Client reported "show in front of card" doing nothing on a specific card
(`/cards/1836448305429612055`, "Most Disturbing Crimes That Happened In Gmod Community"). Root
cause: that card is `type: story`, and stock PLANKA's Story-type Kanban card face
(`Card/StoryContent.jsx`) **never rendered `TaskList` at all** — only the Project-type face
(`Card/ProjectContent.jsx`) did. This wasn't a regression exactly, but the earlier same-day fix
(giving the Checklists *tab* its own "Add task list" button, in `TaskLists.jsx`) is not
card-type-gated, so it became possible to add checklists to Story cards for the first time —
except their `showOnFrontOfCard` setting had nowhere to actually render. Confirmed via DB: the
card had two real checklists with real (non-empty) task rows and `show_on_front_of_card = true`
on both, so this wasn't an empty-checklist or data issue.

Fixed by adding the identical `makeSelectShownOnFrontOfCardTaskListIdsByCardId` selector +
`<TaskList>` render loop to `Card/StoryContent.jsx`, copied verbatim from `ProjectContent.jsx` —
`Card/TaskList/TaskList.jsx` itself has zero card-type coupling, so no changes were needed there.
Verified live: both checklists' progress bars (`2/3`, `0/4`) now render directly on the card face
in the Kanban view for this exact card. Patch: `0024-story-card-face-checklists.patch`.

### Fourth/fifth fixes: checklist name label, single-calendar Dates popup (2026-08-10)

1. **Checklist name wasn't shown next to its own progress bar** on the card face — with 2+
   checklists both `showOnFrontOfCard`, there was no way to tell "2/3" apart from "0/4". Added a
   small bold label (`taskLists.name`) above each progress row in `Card/TaskList/TaskList.jsx`
   (shared by both card-face types, so both Project and Story cards get it).
2. **Combined "Dates" popup simplified from two full calendars to one.** The original Trello-style
   combined-popup design (see "Card sidebar/checklists/dates/activity-log overhaul" above) put a
   full inline `<DatePicker>` under each of Start/Due separately — client asked for one shared
   calendar instead. `EditDueDateStep.jsx` now uses `react-datepicker`'s `selectsRange` mode
   (`startDate`/`endDate` props + a single `onChange([start, end])` handler) — first click sets
   start, second sets due, both still independently overridable via the date/time text boxes above
   (each now with its own small "×" clear button, replacing the old full-width "Remove" buttons).
   Range days get distinct colors in `styles.module.scss` (`--range-start` blue, `--range-end`
   orange, `--in-range`/`--in-selecting-range` a light blue fill for the days between) so it's
   clear which highlighted day is which without needing two calendars.

Patch: `0025-checklist-name-and-single-calendar-dates.patch`. Verified live on
`/cards/1836448305429612055`: each checklist's own name now renders above its progress bar on
the Kanban card face; the Dates popup shows exactly one calendar with both date-group text boxes
above it (only the same-day-default-selection state was screenshotted, not an actual two-day
range pick, to avoid another live write-test after the earlier incident — the range-color CSS
uses react-datepicker's own documented `--range-start`/`--range-end` class names, so it's expected
to render correctly for a real range without further live verification).

### Sixth/seventh fixes: calendar click was inverted, platform date format (2026-08-10)

1. **The single-calendar `selectsRange` approach from the previous fix picked the wrong field.**
   Client feedback: clicking the calendar moved the *start* date (blue), when the expected
   behavior is the opposite — start stays put (defaults to today), and a calendar click should
   only move the *due* date (orange). This is inherent to how `selectsRange` works: every click
   on an already-complete range begins a brand new range, treating that click as the new start.
   Replaced with a plain single-date `<DatePicker selected={dueDate} onChange={...} />` — the
   calendar now only ever sets the due date. The start date is drawn on the same calendar as a
   passive, non-interactive marker via react-datepicker's `highlightDates` prop (a custom blue
   CSS class, `styles.startDateHighlight`), not `selected` — clicking it does nothing, matching
   the "start doesn't move" expectation. Editing the start date only happens via its own text box.
2. **Date format switched to DD/MM/YYYY platform-wide.** Single source of truth:
   `client/src/locales/en-US/core.js`'s `format.date` key (`'M/d/yyyy'` → `'dd/MM/yyyy'`) — every
   date display and every date-text-box parse/format in the app routes through this one
   date-fns-pattern string via the `formatDate`/`parseDate` i18next postprocessors in `i18n.js`,
   so changing it here was sufficient; no other file hardcodes a month-first format.

Patch: `0026-dates-calendar-fix-and-dmy-format.patch`. Verified live: date boxes read `10/08/2026`
(10th of August, correct DD/MM/YYYY) instead of the old `8/10/2026`. Calendar-click behavior itself
wasn't live-tested with an actual click (would require another production write after the earlier
incident) — the fix reuses this same component's own pre-range-mode single-date-picker code
(what it looked like before the "single calendar" fix introduced `selectsRange`), a known-working
pattern rather than new logic.

### Eighth/ninth fixes: faint timeline highlight, dark-mode subtask text color (2026-08-10)

Client confirmed the calendar fix (blue start / orange due) works well and asked for two more
refinements:

1. **Faint highlight for the days between start and due**, so the range reads as a timeline at a
   glance. Deliberately **not** done via react-datepicker's `selectsRange` (that's the exact mode
   that caused the earlier click-target bug — every click on it starts a new range). Instead,
   `EditDueDateStep.jsx` computes the in-between dates by hand (a simple day-by-day loop from
   `startDate+1` to `dueDate-1`, empty array if either date is unset or the range is inverted) and
   passes them to `highlightDates` as a second custom-class group alongside the existing start-date
   marker — a light `rgba(232, 99, 44, 0.2)` fill, same hue as the solid due-date orange but faint.
2. **Checklist item text was unreadable on dark-mode card backgrounds** (`Card/TaskList/Task.jsx`,
   the card-face renderer — not the modal's checklist tab, which is white-background and
   unaffected). `.name` had no color override at all — it inherited the light-mode-only default;
   `.nameCompleted`'s `#aaa` (strikethrough state) happened to already read fine on both
   backgrounds, which is why only the *incomplete* state looked broken. Fixed the same way the
   card title/description already handle this
   (`:global(#app.dark-mode-cards-enabled) { .name { color: ... } }`, see the "fourth/fifth fixes"
   entry above) — added `#9fadbc` for `.name:not(.nameCompleted)` specifically, since `#app`'s id
   selector would otherwise outrank `.nameCompleted`'s plain class and override the
   already-correct completed-state color too. Also lightened the linked-card task's exchange icon
   color, same root cause.

Patch: `0027-calendar-timeline-highlight-and-task-color.patch`. **Not live-verified this round** —
while checking, found the test checklists on the card used for prior verification had been
deleted/recreated several times via the client's *own* live testing session in the meantime
(confirmed via the Actions-tab audit log this feature itself added — same "PLANKA Admin" account,
real `createTaskList`/`completeTask`/`deleteTaskList` entries with timestamps during this work
session). Since the client was actively testing the feature live at the time, deliberately avoided
adding more test data on top of that and left both fixes for them to confirm directly.

## Board-level Gantt view (2026-08-11)

Client asked for a standard horizontal Gantt chart covering every dated card/checklist on a
board, opened via a new button next to Share, with 4 sub-tabs: Timeline (Gantt, grouped by card,
default), Tasks (flat list grouped by card, includes undated items — a full audit), Team workload
(same Gantt renderer, grouped by board member), Schedule (flat agenda list grouped by date).
Confirmed with the client up front: click-a-bar-to-edit (reusing the existing Dates popup, no
drag/resize on the chart itself — no Gantt library in this stack to lean on for that), auto-fit +
scroll date range with a "today" marker instead of zoom controls, and Tasks tab shows undated
items while Timeline/Team workload/Schedule only plot dated ones.

**Pure client-side feature — no migrations, no server changes.** `Card.startDate/dueDate` and
`TaskList.startDate/dueDate/isDueCompleted` (added in the checklists/dates overhaul above) were
already sufficient; `Task` (checklist item) has no dates and was correctly left out of all 4
views, even though it does carry a pre-existing `assigneeUserId` field — that field has no date to
plot, so Team workload attribution is card-membership-only.

- **New selector**, `client/src/selectors/gantt.js` (`selectGanttItemsForCurrentBoard`): the single
  data source for all 4 tabs. Walks `Board.getCardsModelArray()` (already excludes archive/trash
  lists — confirmed by reading the model, not assumed) once per board, returning each card with
  its normalized dates, member IDs, and nested checklist array (also normalized — `Card` dates are
  already `Date` instances via the API transform layer, `TaskList` dates are raw ISO strings, so
  the selector converts both to `Date|null` up front so no tab component needs to care which model
  a date came from).
- **Entry point**: new `ModalTypes.BOARD_GANTT` + `entryActions.openBoardGanttModal()`, mounted
  from `Board.jsx`'s existing modal-type switch (same pattern as `BOARD_SHARE`/`BOARD_ACTIVITIES`).
  New `GanttButton` (`components/boards/GanttButton/`) sits next to `BoardMemberships` (the Share
  button) in `BoardActions.jsx`, gated the same way (`!withContextTitle`, i.e. hidden on
  archive/trash board contexts where a Gantt view wouldn't make sense).
- **Modal shell**: `components/boards/GanttModal/GanttModal.jsx`, `useClosableModal()` +
  `size="fullscreen"` (existing modals in this app use `size="small"`; Gantt needed the room), a
  Semantic UI `<Tab>` with 4 panes using the exact `Menu.Item` + `render` shape already established
  by `CardModal/Communication.jsx`'s Comments/Checklists/Actions tabs.
- **Shared chart renderer**, `components/boards/GanttModal/GanttChart/` (`GanttChart.jsx` +
  `Row.jsx`), used by both Timeline and Team workload. Callers pass a flat, pre-grouped `rows`
  array (`{ key, label, isGroupHeader, isGroupBoundary, startDate, dueDate, cardId?, taskListId? }`)
  rather than a nested groups structure — kept the renderer itself dumb about *why* rows are
  grouped, so Team workload could reuse it unmodified just by building its rows differently
  (member header → that member's dated cards → their dated checklists, using icon-prefixed labels
  for the 3rd visual level instead of a 3rd Row state). Auto-fit range = padded min/max date across
  all rows, min 14 days; day-scale header (month row + day row) computed via `date-fns` submodule
  imports (`differenceInCalendarDays`, `addDays`, `format`, `startOfDay` — first direct component
  use in this codebase; previously only `i18n.js` imported `date-fns` directly). Sticky
  header+left-label column via nested CSS `position: sticky` inside one scrolling container (no
  virtualization — acceptable at this board's real data volume, revisit only if a board turns out
  to need it). Bar color reuses the Dates popup's existing blue-start/orange-due language
  (`#2185d0`/`#e8632c`, gradient when both dates set).
- **Click-to-edit**: each `Row` calls `usePopupInClosableContext(EditDueDateStep)` itself (has to
  be a real per-row component instance for the hooks rule, not called inside the parent's `.map()`)
  — clicking a bar opens the *existing* Dates popup, completely unmodified, targeting `cardId` or
  `taskListId` exactly like every other place it's already wired in. Same pattern reused for the
  non-chart Tasks/Schedule tabs' clickable rows. Edit affordance is gated on
  `selectCurrentUserMembershipForCurrentBoard(...).role === EDITOR` (copied from
  `TaskLists/Item.jsx`'s existing gate) — viewers see the same 4 tabs fully populated, just without
  clickable bars/rows.
- **Tasks tab** intentionally does *not* use `GanttChart` — it's a plain grouped list (card header
  with list badge + date chips, checklist rows with the same `<Progress>`+`X/Y` rendering already
  used on the Kanban card face) so it can show every card/checklist regardless of dates, which the
  chart's auto-fit range can't represent.
- **Schedule tab** flattens dated cards+checklists (keyed by due date, falling back to start date)
  into day-grouped sections using the platform's `format:date` (`dd/MM/yyyy`) key for section
  headers, reusing `DueDateChip` for the individual chips (that component's own internal date
  format — `MMM d, y`-style — is pre-existing/unchanged, used the same way it already is in the
  checklist tab and card sidebar).

Patch: `0028-board-gantt-view.patch`. **Live-verified** via Puppeteer against
bsymedia.duckdns.org's "Yapmaster Media" board (real production data, not seeded): Gantt button
renders correctly next to Share; all 4 tabs render with real cards/checklists; Timeline/Team
workload correctly filter to dated-only items with working bars; Team workload correctly shows
per-member grouping including an "No scheduled items" empty state for members with nothing dated;
Schedule correctly date-groups with `dd/MM/yyyy` section headers; clicking a Timeline bar opened
the existing Dates popup pre-filled with that exact card's real stored dates, confirming the
`cardId`/`taskListId` wiring is correct end-to-end. (Did not click Save during verification — no
data was modified.)

## Sub-task dates/assignees, simplified Dates popup, trimmed card sidebar (2026-08-11)

Follow-up to the checklist overhaul and Gantt view above. Five changes, all client-side except
two small server additions:

- **Checklist items (`Task`) can now have their own start/due dates**, mirroring the exact
  Card/TaskList pattern from the prior session: migration `20260811130000_add_dates_to_task.js`
  (`start_date`/`due_date`/`is_due_completed` on `task`), `startDate`/`dueDate` inputs on
  `tasks/update.js` (`isDueDate` validator, same as `task-lists/update.js`), matching `attr()`
  fields on the client `Task` model. Each checklist item row now shows a compact date chip row
  (when set) and an always-visible calendar-icon button (`EditDueDateStep` with a new `taskId`
  prop) next to its assignee/edit-pencil buttons.
- **Checklists (`TaskList`) now have their own single assignee** — a genuinely new concept,
  distinct from the per-item assignee that already existed. Migration
  `20260811130001_add_assignee_to_task_list.js` adds `assignee_user_id`; `task-lists/update.js`
  validates board membership the same way `tasks/update.js` already did for its own assignee.
  Reuses `task-lists/TaskList/Task/SelectAssigneeStep.jsx` unmodified from the checklist header
  (it turned out to already be fully generic, no Task-specific coupling despite its file
  location) — the checklist header now shows 3 always-visible icons (assignee, dates, pencil)
  instead of 2, with a new `.four` padding class in `Item.module.scss` (the existing
  `.two`/`.three` pattern, +30px per icon).
- **Checklist item assignee button is no longer hover-only** — was `opacity: 0` with a
  `.contentHoverable:hover` reveal in `Task.module.scss`; now `opacity: 1` like the edit pencil
  already was. The button's own render-gating logic (`task.assigneeUserId || isEditable`) needed
  no change — it was purely a CSS trick.
- **Dates popup redesigned into two tabs** (`EditDueDateStep.jsx`) — previously showed both
  dates' fields at once with a single calendar hardwired to drive only the due date; due date's
  text fields were silently pre-filled to today, and Save was hard-blocked unless *both* dates
  parsed, meaning a start-only edit was never actually possible through this popup despite the
  UI suggesting otherwise. Now: "Start Date"/"Due Date" tab switcher (tinted blue/orange to match
  the calendar's own color logic), only the active tab's date+time boxes render, the shared
  calendar's `selected`/`onChange` follow whichever tab is active, and both dates render as
  colored markers on the calendar regardless of active tab (`dueDateHighlight` added alongside
  the existing `startDateHighlight`). Start date still defaults to today; due date now genuinely
  has no default and is optional — leaving it blank and saving no longer touches it (or clears it
  if previously set). Gained a third optional target prop, `taskId`, alongside the existing
  `cardId`/`taskListId` (mutually exclusive, Task dates are ISO strings like TaskList's, not Date
  instances like Card's). A cross-tab-safe focus mechanism (`focusField`/`pendingFocusField`)
  handles the edge case of a validation failure on a field whose tab isn't currently active.
- **Card modal's "Add to card" sidebar section removed entirely** (`ProjectContent.jsx`,
  `StoryContent.jsx`) — client's call, no replacement needed. Its own Members button was an exact
  duplicate of the separate Members section (`AssignedMembers.jsx`) that already existed
  independently; Labels remains reachable both inline in the card's main content and from the
  board-level card three-dot menu (`CardActionsStep.jsx`, confirmed by reading it); Stopwatch,
  checklist-add, attachment-add (drag & drop / paste via `AddAttachmentZone` still works,
  confirmed by reading it — only the explicit browse-button trigger is gone), and custom-field-add
  lost their sidebar shortcut with no replacement, per the client's explicit "I have no use for
  the custom field" / "ensure only Members and Actions remain". Removed the now-fully-dead
  `AddTaskListStep`/`AddAttachmentStep`/`AddCustomFieldGroupStep` imports and their
  `canAddTaskList`/`canAddAttachment`/`canAddCustomFieldGroup` permission flags rather than
  leaving them as unused dead code.
- **Sub-task dates surfaced in the Gantt view** (Timeline/Team workload/Schedule, not Tasks tab —
  client's call): `selectors/gantt.js` adds a `tasks` array (pre-filtered to dated items) to each
  `taskList` entry, plus `assigneeUserId` on both `taskList` and `task`. Rendered as a 3rd
  indentation level under their checklist, using the same "icon-prefixed label with inline
  padding" trick as Team workload's existing 2-level indent — no `Row.jsx` CSS changes needed for
  indentation, but `Row.jsx`/`GanttChart.jsx` did need a new `taskId` prop threaded through to
  `EditDueDateStep` (**caught in testing**: `GanttChart.jsx` accepted `taskId` in its rows'
  `PropTypes.shape` but never actually passed `row.taskId` down to `<Row>` — sub-task bars would
  have rendered but never opened the right popup on click). **Also caught in testing**: Timeline
  and Team workload's checklist-row filters (`taskList.startDate || taskList.dueDate`) only
  surfaced a checklist if the checklist *itself* had dates, silently hiding checklists whose only
  dated content was a sub-task — fixed by also matching `taskList.tasks.length > 0` (that array is
  already pre-filtered to dated items by the selector). Team workload additionally needed a second
  pass + a `pushedTaskListIds` dedup set, since a checklist can now surface for a member either via
  card membership *or* via direct checklist/task assignment (possibly both).

Patch: `0029-sub-task-dates-assignees-dates-popup-sidebar.patch`. **Live-verified** via Puppeteer
against a throwaway sandbox project created and deleted via the API for this purpose (never
touched real client boards) — confirmed: checklist item and checklist header assignee buttons
render without hovering; Dates popup's two tabs, today-default on Start/blank-default on Due,
and both-dates-visible-regardless-of-tab all work exactly as designed; a start-only save (no due
date) succeeds, which the prior single-view popup silently couldn't do; card modal sidebar shows
only Members + Actions; Gantt Timeline and Team workload both correctly show the 3-level
card→checklist→sub-task nesting with a working gradient bar, and clicking the sub-task's bar
opens the Dates popup pre-filled with its real stored dates. Sandbox project (including its one
test card/checklist/task) deleted after verification — no trace left on the live boards, and
production card/project counts were confirmed unchanged before and after.

## Timeline tab data bugs + Tier 1 fixes (2026-08-12)

**First thing found, unrelated to the two reported bugs**: the container serving production at the
time (built 2026-08-11 19:30:22) predated the sub-task/assignee patch's commit (19:35:28) by 5
minutes — the "live-verified" claims for that patch were checked against a build that didn't
actually contain it. This session's rebuild (below) is the first time it's genuinely been live.

**Bug 1 ("no bars draw") — diagnosed as a default-viewport bug, not a data bug.** Traced the full
path (`card`/`task_list` tables → `boards/show.js`'s plain `.find()` → live API response, checked
directly with `curl` against a real admin token → redux-orm models → `selectors/gantt.js` →
`GanttChart.jsx`) and dates are intact at every hop — confirmed by diffing the live API payload
against direct Postgres queries on the real "Yapmaster Media" board, byte-for-byte matching. The
actual defect: `GanttChart.jsx` auto-fits its day-scale header to the full min→max date span across
every row, then leaves the scroll container at `scrollLeft: 0` (oldest date) with no scroll-to-today
— on real data (dated items spanning 2025-01-30 → 2026-08-14) that's an 18,308px-wide chart in a
1,763px viewport, so a user opening the tab lands on Jan 2025 where almost nothing is dated, and
every real bar is scrolled far off-screen to the right. Confirmed by scrolling that same container
programmatically in a live headless-browser session — bars render exactly where the DB says they
should, just off the default viewport. Fixed with a `useEffect` in `GanttChart.jsx` that scrolls to
today (clamped into range, offset ~25% from the left edge) whenever the computed range changes.

**Bug 2 ("every card shows as a row") — real, but the intended fix needed a client decision
first.** Actual live row count on a real board was 34 (not literally 187/"every card" — the
existing filter already excluded undated cards), but the hierarchy was Card (bar) → Checklist (bar)
→ checklist-item (bar), all three levels mixed together, putting a bar on every dated *card*, which
the client didn't want. Client's brief said rows should be "the checklist items inside each card"
(Planka's `Task` model), but Tier 3 of the same brief talks about ordering by "the card's
checklists" and per-"main task" color — language that fits `TaskList` (Planka's "checklist"), not
the leaf item. Real data made this a genuine fork, not a coin flip: on the reference board only 3
`TaskList`s exist (1 dated) vs. 3 `Task`s (0 dated) — picking the leaf-item reading would have taken
Timeline to zero visible bars. Asked the client directly; confirmed **rows = `TaskList` /
checklist**. `Timeline.jsx` rewritten: no card-level bars (cards get a plain bar-less header row,
only when they have ≥1 dated checklist underneath), no checklist-item-level rows at all. Undated
checklists are hidden from Timeline entirely (not a muted placeholder) — consistent with the
pre-existing, client-approved design where the Tasks tab is the exhaustive undated-items audit and
Timeline stays purely-dated.

**Tier 1 also delivered**: today-marker code already existed (`todayOffset`/`.todayLine`) from the
original Gantt patch but was equally invisible behind the same off-screen-by-default bug above, so
fixing the scroll position surfaces it for free. Added inline bar labels (`Row.jsx`) — wide bars
(≥70px) get the row's name printed inside in white; narrow ones get it printed just to the right in
dark text, since a 1-day bar has no room for its own label. Left-column titles now wrap two lines
(`-webkit-line-clamp: 2`) instead of end-truncating — the client's own card titles are long
with the distinguishing part at the end, which end-truncation was hiding — plus a native `title`
tooltip with the full text as a hover backup. Row height bumped 34px → 42px to fit two lines
without cramming. `GanttChart.jsx`/`Row.jsx`/`Row.module.scss` are shared with the Team workload
tab (per the original architecture, "kept the renderer itself dumb about *why* rows are grouped")
— all of the above therefore also improved Team workload for free; Team workload's own row
hierarchy (member → card → checklist) was not touched, only visually verified unbroken. Tasks and
Schedule tabs use neither shared component and were not touched.

Patch: `planka-custom/patches/0031-timeline-tab-fixes.patch`. **Note on patch numbering**: found an
untracked, uncommitted `0030-checklist-task-assignee-ping-notifications.patch` already sitting in
the patches directory (unrelated in-progress work, not documented anywhere yet, not mine) — set it
aside during this session's build so it wouldn't get shipped as an untested side effect of this
rebuild, then restored it byte-for-byte afterward, untouched. This session's own patch is numbered
`0031` to avoid the collision; `0030` still needs to land under its own patch (and its own
CLAUDE.md entry) whenever that other work is finished.

**Deployed and live-verified 2026-08-12** via a real headless-browser session against
`bsymedia.duckdns.org`'s live "Yapmaster Media" board (real production data): Timeline now opens
already scrolled to today, shows exactly the 1 real dated checklist on this board as a labeled
gradient bar under its card's plain header row, red today-line visible and correctly positioned;
Team workload/Tasks/Schedule screenshotted afterward and confirmed unaffected. Client confirmed
bars render correctly; Tier 2 followed in the same session (see below).

## Timeline tab Tier 2 — zoom, density, shading (2026-08-12)

Built on the Tier 1 patch above, same session. New workspace baseline included patches through
`0031` (i.e. also picked up the concurrent ping-notifications session's `0030`, which had landed
in the meantime — see that section's own "concurrent-session note" for the cache gotcha hit
rebuilding this).

- **Zoom control (Day/Week/Month)**: `GanttChart.jsx` previously hardcoded one `DAY_WIDTH=32`
  pixels-per-day constant; replaced with a `SCALES` map (`day: 32px/14-day min span`, `week:
  10px/12-week min span`, `month: 3px/365-day min span`) selected via a `Button.Group` in a new
  toolbar row, local `useState`, defaulting to Day. The min-range-days now scales with zoom so
  Week/Month don't auto-fit down to a useless few-week span when the board's real date spread is
  narrow. Header sub-row swaps: Day shows per-day numbers (unchanged), Week shows per-ISO-week
  segments (`startOfWeek`-keyed), Month shows no sub-row at all (month row only). The month-band
  computation, weekend-offset list, and today-offset are all still derived once in the same
  `range` `useMemo`, now keyed off the active scale's `minRangeDays` alongside `rows`.
  Auto-scroll-to-today (from Tier 1) now uses the active scale's `dayWidth`, so it still lands
  correctly at every zoom level - verified live at all three.
- **Minimum bar width decoupled from zoom**: at Month scale `dayWidth` drops to 3px, which would
  round a short multi-day bar down to a sliver. `Row.jsx`'s bar-width floor changed from `dayWidth`
  itself to a fixed `MIN_BAR_WIDTH = 6`, so short bars stay visible/clickable at every zoom level
  instead of only at Day scale.
- **Weekend + alternating-month shading**: two new absolutely-positioned layers in `.body`
  (`GanttChart.module.scss`'s `.weekendShade`/`.monthShade`), computed once per `range` (weekend
  day offsets; every other month segment). Weekend shading is skipped at Month scale (individual
  days aren't resolvable at 3px anyway). **Real stacking-context bug caught before shipping**:
  position-absolute shading siblings in `.body` paint above statically-positioned row content
  regardless of DOM order per CSS spec, which would have buried every bar under an opaque shading
  layer - confirmed by reasoning through the same mechanism already visible in the pre-existing
  `.todayLine` (which *does* intentionally paint over bars, crossing them, in the Tier 1
  screenshots). Fixed by giving `Row.module.scss`'s `.row` its own stacking context
  (`position: relative; z-index: 1`), with shading at `z-index: 0` and the today-line kept at
  `z-index: 2` so it still crosses bars on purpose. Live-verified after the fact - shading renders
  behind bars/labels correctly, not on top.
- **Tighter row density**: row height 42px → 36px (the height Tier 1 had bumped to for its 2-line
  label wrap), label font-size 13px → 12px, `.labelText` line-height tightened to 13px - two lines
  still fit cleanly, just in less vertical space. Bar/bar-label vertical offsets recalculated to
  stay centered in the shorter row (`top: 11px` → `8px` for a 20px-tall bar in a 36px row).
- **Sticky headers - confirmed, not changed**: both the top date header (`position: sticky; top:
  0`) and the left label column (`position: sticky; left: 0`) already existed from the original
  Gantt patch and were never broken by Tier 1/2's other edits. Explicitly re-verified this session
  by scripting a live scroll (`scrollTop`/`scrollLeft` both nonzero simultaneously) and
  screenshotting mid-scroll: header stayed pinned to the top and row labels stayed pinned to the
  left, both at once, confirmed visually rather than just re-reading the CSS.

Patch: `planka-custom/patches/0032-timeline-tier2-zoom-density-shading.patch`. **Deployed and
live-verified 2026-08-12** via a real headless-browser session against the live "Yapmaster Media"
board's Team workload tab (richer real dataset than Timeline's single dated checklist) at all
three zoom levels, plus the Timeline tab itself at Day scale - Month scale in particular
correctly auto-fit to the board's full ~16-month real date spread with a working today-line and
still-visible/clickable minimum-width bars. Rebuilt with `docker compose build --no-cache`
throughout, per the cache gotcha noted above/in the ping-notifications section, and reconfirmed
via screenshot (not just a successful build log) that the deployed container actually served the
new zoom control before calling this done.

## Timeline tab Tier 3 — checklist sequencing + per-checklist color (2026-08-12)

- **Sequence order**: turned out to already be correct, nothing to build. `Card.getTaskListsQuerySet()`
  (the source `selectGanttItemsForCurrentBoard` walks) already sorts by `position` - the same field
  the checklist drag-and-drop in the card modal itself uses - and `Timeline.jsx`'s row-building loop
  just preserves that array order. Confirmed against real data, not just the code: the one card with
  two checklists has "Scriptwriting" at `position 65536` and "Video Editing" at `position 131072`,
  matching the order shown in the card. Documented in `Timeline.jsx` itself so it doesn't look like
  an oversight later.
- **Per-checklist color, shared team-wide (client's explicit choice over a per-browser/localStorage
  option)**: new `gantt_task_list_colors` table in `planka_ops` (never Planka's own schema - same
  rule as everything else there), one row per `TaskList` id, holding a `#rrggbb` hex value.
  - **Two new invite-service routes**, `GET`/`POST /api/gantt-colors`, same Bearer-token-via-the-
    caller's-own-PLANKA-access-token pattern as the existing `/api/send` (Share modal invite), which
    they sit next to in `index.js`. `planka.getBoardAuthContext` extended to also return
    `boardMemberships` (PLANKA's `/api/projects` already scopes `included.boardMemberships` to the
    *caller's own* memberships per its controller source - confirmed by reading it - so a plain
    editor/viewer's role is findable with zero extra API calls). Write access requires board-editor
    role OR project-manager-of-that-project OR the existing admin-bypass-except-personal-projects
    rule (`isBoardEditor()`, mirrors `/api/send`'s existing authorization exactly rather than
    inventing a fourth rule); read access only requires the board to be visible to the caller at all.
  - **Real bug found and fixed while building this, not specific to the new feature**: a
    real-browser-logged-in admin's token was silently rejected (401, "invalid or expired session")
    by both new routes even though the identical token worked fine for every call PLANKA's own React
    client made in that same tab - confirmed by reproducing with a live Puppeteer session, then
    isolating it down to a raw internal `wget`/`fetch` call from inside the invite-service container.
    Root cause, found by reading `server/api/hooks/current-user/index.js`: PLANKA's own client always
    logs in with `withHttpOnlyToken=true` (`client/src/api/access-tokens.js`), which binds that
    session to a second, `httpOnly` `httpOnlyToken` cookie that the server requires to *also* match
    on every subsequent API call - the bearer JWT alone isn't sufficient once a session has one. A
    token minted directly via a raw `POST /api/access-tokens` (no `withHttpOnlyToken`, e.g. every
    manual `curl` test run during this session) never has this binding, which is exactly why manual
    curl-based testing kept "working" and masked the gap. **This equally affects the already-shipped
    `/api/send` route** (same auth pattern, same missing cookie forward) - likely silently broken for
    any admin using a normal logged-in browser tab to invite by email, not just this new feature.
    Fixed in both places: `extractHttpOnlyToken()` reads the cookie off the *inbound* request
    (`path: baseUrlPath || '/'` on that cookie means it does reach invite-service's routes too, same
    domain), `planka.js`'s `request()`/`getMe()`/`getBoardAuthContext()` now accept and forward it as
    a `Cookie:` header on invite-service's *outbound* call to PLANKA. No cookie-parser dependency
    added - one cookie, parsed with a one-line regex. Verified the fix directly: the exact
    browser-extracted token that produced a 401 before now returns 200 from both routes, still using
    the identical token string.
  - **Client**: `ColorPickerStep.jsx` (new, mirrors `lists/List/EditColorStep.jsx`'s Popup.Header/
    Content + swatch-grid + clear-button shape, but selects a raw hex value against a standalone
    10-color palette - `constants/GanttTaskListColors.js` - rather than one of Planka's own named
    `ListColors`, since this state lives in invite-service/planka_ops, not a Planka record).
    `Timeline.jsx` fetches the board's colors once on mount/board-change and passes a `color`
    per-row plus an `onColorChange` callback down through `GanttChart.jsx` to `Row.jsx` - both left
    otherwise untouched for Team workload, which never passes `onColorChange` and so never renders
    the picker or applies a custom color, exactly as scoped ("Timeline tab only"). `Row.jsx`: a
    chosen color replaces the default blue-start/orange-due gradient entirely (a manual stage color
    and a date-semantic gradient don't mix); a small color dot sits next to the checklist's label -
    clickable (opens the picker) for editors, a plain read-only dot for viewers once a color is
    actually set, so the whole team reads one consistent legend without offering viewers a control
    they can't use.

Patch: `planka-custom/patches/0033-timeline-tier3-checklist-color.patch` (client) +
`invite-service/src/{db,index,planka}.js` (server, not part of the patch pipeline - invite-service
builds from its own real source tree, not a clone+patch flow). **Deployed and live-verified
2026-08-12**: real end-to-end round trip against the live board via a Puppeteer session - opened the
picker on the real "Scriptwriting" checklist, picked a color, watched the bar and label-dot update
immediately, confirmed the row in `planka_ops.gantt_task_list_colors` directly, then loaded the
Timeline tab in a **completely fresh** browser session (new login, no client-side state carried
over) and confirmed the color was still there. Test color cleared back to unset afterward via the
same API (`color: null`) so the client's own real choice isn't pre-empted by test data - confirmed
the table is empty again before finishing.

## Taiga import (2026-08-07)

Client is consolidating a second source into the same PLANKA instance: some of BSY Media's work
lived in Taiga (Kanban board, single project export, not a live API pull) and needed to move in
alongside the still-pending Trello migration (see below). Source export file:
`/home/deploy/yapmaster media - 07082026.json` (**note the space in the filename**) — kept outside
this repo, same as the eventual Trello export will be, since it's a one-time source artifact
containing real staff names/emails/comments, not a deliverable.

### Generic import framework (`scripts/import/`)

Built adapter-agnostic on purpose — this is meant to be Phase 2's starting point too, not a
Taiga-only tool:
- `lib/framework.js` — gap-analysis, dry-run, idempotent `apply`, count-verification, all working
  against a normalized model (`{ project, columns, members, cards, gapNotes, stats }`) any adapter
  can produce.
- `lib/planka-client.js` — extended PLANKA API wrapper (projects/boards/lists/cards/task-lists/
  tasks/comments/attachments/card-memberships/board-memberships), kept separate from
  `invite-service/src/planka.js` since the two have different lifecycles and this one needs
  multipart file upload.
- `lib/db.js` — two new tables in the existing `planka_ops` database (never the PLANKA schema
  itself, which must never be hand-mutated): `import_entities` (a manifest of every
  `source/entityType/sourceRef → plankaId` mapping ever created — this is what makes `apply`
  idempotent; reruns skip anything already recorded and only create what's missing) and
  `cycle_time_events` (derived move-history seed data, kept separate from PLANKA's own action log
  since the API has no way to backdate a card's real creation/move timestamps).
- `adapters/taiga.js` — the actual Taiga-specific parsing; this is the only part that's genuinely
  new per source. A future Trello adapter reuses everything above unchanged.
- `run.sh` — runs the CLI inside a throwaway container built from the **existing invite-service
  image** (`docker compose run --rm --no-deps`), reusing its network access to `planka`/`postgres`
  and its already-installed `pg` package via `NODE_PATH=/app/node_modules`. Deliberately avoids
  adding a new service to `docker-compose.yml`, installing new dependencies, or publishing any new
  ports for what's a one-off migration tool.
- Reports (`scripts/import/reports/*.md`) and any future state dir are gitignored — like the
  backups, they can contain real staff PII (names, emails, comment text) and must never land in
  git.

### What the Taiga export actually looks like (verified against the real file, not assumed)

- Kanban only, confirmed (`is_kanban_activated: true`, `is_backlog_activated: false`, no
  sprints/points) — 15 columns (`us_statuses`), 180 cards (`user_stories`).
- Swimlanes and WIP limits are both **configured-but-unused** in this particular export (0
  swimlanes, no column has a `wip_limit` set) — so despite being unrepresentable in PLANKA, nothing
  was actually lost for this project. Still surfaced in the gap-analysis report rather than assumed
  safe to skip.
- Attachments are **embedded as base64 directly in the export**, not URL references like Trello's
  export — simpler than expected: decode + multipart-upload, no download step or broken-link risk.
- The top-level `us_statuses` list has **no `id` field**, only names — but history entries
  reference stable numeric status IDs, and 2 columns were renamed mid-project. Column identity for
  historical move events has to be resolved by scanning every history entry's `values.status` map
  and taking the chronologically-latest name per ID; verified this reconstructs all 17 IDs (15
  story statuses + 2 task statuses) with zero orphans before trusting it for cycle-time seeding.
- PLANKA can't post a comment "as" another user (`comments/create.js` always attributes to the
  authenticated caller) — migrated comments are posted by the service account with a text prefix
  (`_[originally posted by NAME <email> on DATE]_`) rather than silently losing the original
  author.
- Only 1 real Taiga `task` (checklist item) exists in the whole export — the "tasks under a story
  → checklist items" mapping is real but affects almost no cards in this dataset.

### Import result (2026-08-07, count-verified with zero discrepancies)

180/180 cards, 331/331 comments (2 excluded — deleted in Taiga, `delete_comment_date` set,
reversible if the client wants them back), 57/57 attachments (78.2MB, 0 failed uploads), 1/1
checklist item, matched per-column too (all 15 lists). 1222 cycle-time events seeded into
`planka_ops.cycle_time_events` (180 `created` + 1042 `moved`) — **this is real historical seed
data for Phase 3**, not synthetic, the same way Phase 2's Trello import is meant to seed it (see
both sections below).

- **Member mapping**: 0 of 75 referenced Taiga members currently matched a PLANKA account (real
  staff hadn't signed up via invite-service yet at import time) — 299 card assignments were
  skipped rather than blocking the whole import on 100% signup turnout, which isn't guaranteed to
  ever happen (16 of the 75 have no live Taiga membership record anymore, including one literal
  `deleted-user-...@taiga.io` placeholder). Unmatched members are listed in the gap-analysis
  report for manual resolution, never auto-created. `apply` is idempotent and safe to rerun as
  staff sign up — it only fills in newly-matched assignments, never duplicates anything.
- **32 cards carry a Trello back-reference** (`external_reference` pointing at a trello.com URL) —
  these were originally migrated Trello → Taiga by the client before this project existed. Not
  deduped against a future Trello import (client's call) — listed explicitly in the gap-analysis
  report so they can be manually reconciled if/when Phase 2 runs against overlapping content.
- After import, the human admin account had **no access at all** to the new board — project/board
  creation via the service account only makes the service account a project manager, it doesn't
  grant any human account access. Had to manually grant `admin@planka.local` project-manager
  status via `POST /projects/:id/project-managers`. This will recur for every future
  service-account-created board unless proactively handled — either via `/invite/assign` per
  board, or by making the import tool always grant a configured admin project-manager status as
  part of `apply` (not yet done, flagged here for later).

### Bugs found and fixed while running this for real

- PLANKA's card-create endpoint rejects an explicit `dueDate: null` (`allowNull` isn't set on that
  input, unlike `description` which does allow it) — must omit the key entirely when there's no
  due date. Fixed in `planka-client.js`; the idempotent manifest meant the retry resumed cleanly
  from the already-created project/board/lists instead of redoing them.
- Self-signup/invite-accept's "Your name" field was mistaken by a real user for a login username —
  it only ever sets PLANKA's display `name`, never the separate `username` field, so nothing
  typed there could ever be used to log in. Fixed the affected account directly (admins can set
  any user's `username` via `PATCH /users/:id/username` without needing their password), and added
  a clarifying line under that field on both `/invite/join` and `/invite/accept/:token`:
  *"This is just your display name in PLANKA, not a login name — you'll always log in with your
  email."* Deliberately didn't add a real separate username field to the form (client's call) —
  anyone who wants a login username can still set one in their own PLANKA Account Settings later.
- `card-memberships/create.js` requires the target user to already have **board membership**
  before they can be added to a card (`isBoardMember` check, 404s otherwise) — `apply()` was
  throwing and aborting the whole run partway through on the first matched-but-not-board-member
  user. Fixed: `apply()` now grants editor board access up front for every matched assignee before
  attempting card-level assignments, and per-assignment failures are caught and reported instead
  of aborting the whole run.

### Re-running against a newer re-export ("update apply") — 2026-08-11

The client re-exported both Yapmaster Media and Unindexed Media from Taiga (`/home/deploy/yapmaster
media - 11082026.json`, `/home/deploy/thaireis-unindexed-media-new.json`) weeks after the initial
import, expecting the existing boards to pick up what changed. The tool as built for the initial
one-time migration was **not actually safe to rerun against an updated export** — found and fixed
two real bugs before running it against production:

- **Idempotency was keyed on the source file's SHA-256 hash**, not just `(source, entityType,
  sourceRef)`. A newer export has a different hash, so every already-imported entity would have
  looked "new" and `apply()` would have recreated all 180+23 cards (plus their comments/lists/etc.)
  as duplicates on top of the existing boards. Fixed in `lib/db.js`: `source_file_sha256` is now
  an audit-only column (records which file last touched a row), dropped from the uniqueness
  constraint on both `import_entities` and `cycle_time_events`.
- That fix immediately surfaced a **second, latent bug**: the adapter used a bare `source: 'taiga'`
  for every project, and Taiga's `ref` numbers and column slugs are only unique *within* a project
  (e.g. every project has a card `ref 1` and a `review` column) — three already-imported projects
  sharing one identity namespace collided the moment file-hash stopped disambiguating them. Fixed
  by scoping `source` per project slug in `adapters/taiga.js` (`taiga:<project-slug>`), plus a
  one-time backfill migration in `db.js` that rewrites the ~450 already-existing rows from the bare
  `taiga` source to the correct `taiga:<slug>` using the known sha256→slug mapping of this
  deployment's 3 already-imported export files (Yapmaster, Unindexed Media, Disturbing Place) —
  verified zero identity collisions remained before adding the new constraint.
- `apply()` previously only ever filled in *missing* entities — a reused card was never checked
  against the new export for a changed title/description/due date/column. Added a sync step
  (`lib/planka-client.js`'s new `updateCard`, called from `framework.js`): after fetching the
  board's current card state once up front, any reused card whose name/description/dueDate/column
  differs from the new export gets `PATCH /api/cards/:id`'d (column moves compute the append
  position via `getCardsInList` on the target list). Reported as a new `Updated` bucket in the
  apply-result report, separate from `Created`/`Reused`.

Diffed both new export files against the previously-imported ones by story `ref` before touching
anything, to know exactly what to expect: **Yapmaster Media** — 7 new cards, 1 new column
("Compilations"), 7 existing cards moved to a different column, 1 new comment.
**Unindexed Media** — 0 new cards, 1 existing card's description edited + 4 new comments. Took a
manual off-cycle backup (`scripts/backup.sh`, offsite to Mega) before applying. `--apply` results
matched these numbers exactly for both boards with zero duplicate cards created, and `--verify`
confirmed all card/column counts. Two apparent verify "mismatches" on Yapmaster (2 extra checklist
items, 1 extra native comment) were confirmed via direct DB inspection to be real staff activity
through the live board on 2026-08-09/11 (using the checklist/comment features from the prior
session's work) — not caused by this run, and outside what a Taiga-snapshot comparison can know
about.

### Members-only companion tool ("apply the board json so newer members get added") — 2026-08-15

Client asked to re-run the member-matching step (more staff have signed up since the last full
`--apply` on 2026-08-11) but explicitly **not** touch any cards — a real concern, since `--apply`
bundles membership-granting together with a card-content sync step that has its own documented
history of risk (see "Re-running against a newer re-export" above, and the card-clobber incident
noted inline in `framework.js`). There was no existing way to run just the safe half.

Added `scripts/import/add-members-only.js` — reuses `framework.matchMembers` and the exact same
`assigneeEmailsUsed` criterion (assignees + comment authors) `--apply`'s own membership step
already uses, so "who needs board access" is still defined in exactly one place. It never calls
`createCard`/`updateCard`/`createComment`/`createTaskList`/`createTask`/`createFileAttachment` at
all — not just "skips them if unnecessary," genuinely does not have the code path. Supports
`--dry-run` to preview before writing (prints matched/unmatched counts and exactly who would be
granted, same style as the existing `--gap-analysis`/`--dry-run` reports).

Run against all 3 currently-imported Taiga projects (Yapmaster Media, Unindexed Media, Disturbing
Place / `themaze420-classified`), using each project's latest available export file: **14 new
board memberships granted**, 3 people who already had access (through some other path) recorded
into the `import_entities` ledger for consistency. Zero card/comment/checklist/attachment writes —
confirmed both by the script's own report and by construction, not just by reading the output.

**Real gotcha hit along the way**: granting a board membership requires genuine **project-manager**
status on that project — not just PLANKA's instance-wide `admin` role, and not just being a board
editor. `admin@planka.local` was already a project manager on Yapmaster (from the original 2026-08-07
import gap noted above) but not on the other two projects (only `admin@bsymedia.com` and
`therealmorim@gmail.com` were) — and `board-memberships/create.js` disguises that authorization
failure as a plain `404 "Board not found"`, not a clear permission error, exactly the kind of
misleading-error pattern this deployment has hit before (`comments/create.js`'s similar disguised
"Card not found"). Fixed by granting `admin@planka.local` project-manager status on the other two
projects as well (client did this directly), matching what was already done for Yapmaster.

## Trello import (Phase 2 — not started)

Deferred so far at the client's explicit direction ("leave the trello import" — 2026-08-06). Plan
below is carried over from the brief, not yet executed against a real export.

**The generic import framework this needs already exists and is proven end-to-end** (see "Taiga
import" above, `scripts/import/`) — Phase 2 now only needs a Trello-specific
`adapters/trello.js` mirroring `adapters/taiga.js`'s contract, not the gap-analysis/dry-run/apply/
verify machinery itself.

- **Inventory first.** Parse the Trello export and report counts (boards, lists, cards, comments,
  attachments, checklists, labels, members, custom fields) before writing anything, and identify
  what PLANKA can and cannot represent.
- **Gap analysis before importing anything** — the client needs to know in advance what won't
  survive the move. Nothing gets silently dropped.
- **Attachments** are referenced by URL in a Trello export, not embedded — the importer has to
  download and re-upload each one, flagging anything inaccessible.
- **Member mapping**: Trello members with no matching PLANKA/invite-service account get listed
  for manual resolution, never auto-created or silently skipped.
- **Dry-run mode is mandatory.** Report exactly what would be created, without writing. Migrate
  one representative board first for the client to eyeball before doing the rest.
- **Verification script**: compare source vs. destination counts per board, report discrepancies.
- **Don't discard the Trello action history.** The export's `createCard`/`updateCard` actions
  (with `listBefore`/`listAfter` and timestamps) are exactly what Phase 3's cycle-time metric
  needs as seed data — extract this during import rather than letting Phase 3 start from an empty
  history. Confirm the export actually contains this (check the real JSON structure) before
  promising it to the client. Same pattern already proven end-to-end for Taiga (see above,
  `planka_ops.cycle_time_events`) — the Trello adapter just needs to populate the same table.
- Not yet obtained from the client: the actual Trello export file, and a board count to migrate.
  Both are blocking — nothing here can start until they're in hand.

## Cycle-time reporting (Phase 3 — not started)

Blocked on one decision from the client: presentation format (dashboard vs. scheduled CSV/email
export vs. something else) — asked, not yet answered as of last check.

- **Data source already verified live** (2026-08-04, see "Verified" section above): `GET
  /cards/{id}/actions` returns `createCard` and `moveCard` events, with `moveCard` including
  `fromList`/`toList` (name + type) — sufficient to compute both metrics below via the API,
  without needing direct Postgres reads against PLANKA's `actions` table.
- Two numbers per card, not one, per the brief: **lead time** (created → moved to Finished) and
  **cycle time** (moved into the first in-progress list → moved to Finished) — lead time alone
  mostly measures backlog sitting time, not team speed.
- Must store derived metrics in a separate database/table from PLANKA's own (never mutate
  PLANKA's schema — it'll break on upgrade). `planka_ops` (already created for invite-service
  state) is the natural home — **already done**, in fact: the Taiga import (see above) seeded
  1222 real move events into `planka_ops.cycle_time_events` for the Yapmaster Media board on
  2026-08-07. Whatever Phase 3 builds should query that table rather than starting from scratch.
- Edge cases the brief calls out explicitly, still to design for: cards that move backwards out
  of Finished; cards that re-enter Finished more than once (use the final entry); cards that never
  reach Finished (report as "in flight, N days open"); cards deleted/archived mid-flight; boards
  whose done-list isn't literally named "Finished" (make the done-list identification
  configurable per board, not a hardcoded string match).
- Stuck-card alert (anything open past a configurable threshold) — the brief flags the client will
  likely want this more than the averages he explicitly asked for.
- Real seed history already exists now (Taiga import, see above) rather than this being purely
  hypothetical — worth reconsidering build order now that there's real data to build/test against,
  and Phase 2's Trello import will add more once it lands.

## Licensing

Confirmed via live read of `LICENSE.md` and `LICENSES/PLANKA License Guide EN.md` on 2026-08-04:
self-hosting for ~100 employees of one organization, on that organization's own server, with no
resale/third-party hosting, falls under the free Fair Use License — explicitly named as an
allowed example ("internally within your own organization"). No seat cap in the license text.

## Ping notifications for checklist owner / sub-task assignee (2026-08-12)

Client wants a real notification (not just a visual avatar) when a user is tagged/assigned on a
checklist or sub-task. Both `TaskList.assigneeUserId` and `Task.assigneeUserId` already existed
(added for the Gantt view) but were purely cosmetic — setting them never notified anyone.

Verified against the live deployment (not assumed from upstream docs) that PLANKA already has a
complete personal-notification pipeline, just never wired up for these two fields: `Action.js`'s
`PERSONAL_NOTIFIABLE_TYPES` list turns any action type into a directed, self-skip-aware
notification the instant it's created via `sails.helpers.actions.createOne` — this is exactly how
`addMemberToCard` already works. Added two new types, `ASSIGN_TASK_LIST`/`ASSIGN_TASK`, to that
list (and to `Notification.js`'s own separate `Types` enum, which must mirror it — `action.type`
is passed straight through as `notification.type`). Wired a side-effect block into
`task-lists/update-one.js` and `tasks/update-one.js`, right next to the existing name/date/
completion Action-logging blocks, that fires only when `assigneeUserId` changes to a new non-null
value (`taskList.assigneeUserId !== inputs.record.assigneeUserId`) — so unassigning, no-op
resaves, and self-assignment (via the existing `PERSONAL_NOTIFIABLE_TYPES` self-skip) all
correctly produce zero notifications. Client-side: two new `case`s in
`NotificationsStep/Item.jsx`'s switch, two new i18n keys, two new `NotificationTypes` enum
entries — everything else (socket delivery, the bell badge, the redux-orm model) is already fully
generic over notification type.

**Descoped, confirmed with the client**: card-description `@mentions`. Comments use a dedicated
`react-mentions` input with built-in autocomplete; the description field uses
`@gravity-ui/markdown-editor`, which has no mention-extension support at all (checked their docs/
GitHub — nothing to hook into). Real mention support there would mean custom ProseMirror/
CodeMirror engineering, a separate and substantially larger effort. Can be scoped on its own later
if wanted.

**Concurrent-session note**: found an untracked `0030-...patch` already sitting in the patches
directory from a different, still-running session's Timeline-tab-fixes work — that session
deliberately set it aside during its own build/deploy so it wouldn't ship untested, then restored
it byte-for-byte and numbered its own patch `0031` to avoid the collision (see their note under
"Timeline tab data bugs" above). Both patches ended up in the same rebuild since a `--no-cache`
build was needed anyway (a plain `docker compose build` had silently served a stale cached layer
that omitted patch changes — worth remembering: **always rebuild with `--no-cache` after adding a
new patch file**, don't trust a cache-hit build to notice a new file in `patches/`). Verified via
`docker exec ... grep` that the running container's `Action.js`/`update-one.js` files actually
contain the new code before trusting any live test.

Patch: `planka-custom/patches/0030-checklist-task-assignee-ping-notifications.patch`. **Deployed
and live-verified 2026-08-12** via direct Postgres inspection (both notification rows created with
correct `type`/`data`, confirmed no ping on no-op resave/self-assign/unassign) plus a real
headless-browser session logged in as a throwaway second user, showing the notification bell with
the correct "assigned you to checklist «X»" / "...sub-task «Y» in checklist «X»" text and working
card links. All verification used an isolated sandbox project + throwaway user created and fully
deleted via the API afterward — confirmed zero trace left in `project`/`user_account`/
`notification` tables.

## Card tab rename, Submissions tab, exact timestamps (2026-08-13)

Client wants the card-modal tab bar reorganized (Comments → Updates, Checklists → Tasks, Actions
→ Activity), a new "Submissions" tab for deliverables/links kept separate from day-to-day
"Updates," order **Updates, Submissions, Tasks, Activity** with Updates default, and an
always-visible exact date+time on every comment/submission/activity entry (not just relative
"time ago"). Confirmed with client: Submissions is text+links only (reuses the existing
attachments feature for real files), and "notify regardless of tab" is scoped to posts
(Updates + Submissions), not checklist/activity changes.

Found that PLANKA already has this exact "independently-paginated per-card feed" pattern twice
(Comments, Activities — separate `isXFetching`/`isAllXFetched`/`lastXId` Card fields, separate
entry-action/saga/reducer chains, separate selectors). Implemented Submissions as a third
instance of the same pattern via a new `type` column (`update`/`submission`, defaulting to
`update`) on the existing `Comment` model — **not** a new sibling model — so the create/update/
delete routes, the mention pipeline, the subscriber-notification pipeline
(`comments/create-one.js`), and the real-time socket broadcast are reused completely unchanged;
none of that code cares about `type`. Server: `Comment.Types` const + `type` attribute + migration
`20260813150000_add_type_to_comment.js` (Postgres backfills all 432 existing rows to `update` via
the column default, verified post-deploy — zero comments lost or misfiled). `Comment.qm.
getByCardId` gained an optional `type` filter (its only call site, `comments/index.js`, passes it
through). Client: mirrored Card's `lastCommentId`/`isCommentsFetching`/`isAllCommentsFetched` triad
as `lastSubmissionId`/`isSubmissionsFetching`/`isAllSubmissionsFetched`, added
`getSubmissionsModelArray()` next to `getCommentsModelArray()` — and had to **fix
`getCommentsModelArray()` to filter to `type === 'update'`**, since `this.comments` (the reverse
FK) now mixes both types. `Comments.jsx`/`Add.jsx` took a `type`/`placeholder` prop to branch
selector/fetch-action/composer-placeholder rather than forking into two components;
`Item.jsx`/`Edit.jsx` needed zero changes since they already operate generically on a comment id.

Exact timestamps: reused the existing `getDateFormat`/`format:longDateTime`/`format:fullDateTime`
i18next machinery (already used for start/due-date activity text) and `TimeAgo`'s own internal
hover-tooltip formatter — just rendered as always-visible text next to the existing relative
`<TimeAgo>` in `Comments/Item.jsx` and `CardActivities/Item.jsx`, joined with `·`. One rendering
fix in both files covers Updates, Submissions, and Activity. Renders as e.g. `just now · August 13
at 5:20 AM` (current year) or `· August 13, 2025 at 5:20 AM` (prior year).

i18n: `common.tasks` already existed (from the Gantt modal's own "Tasks" tab) and was reused
verbatim; `common.actions` was left untouched since it's shared with an unrelated board-level
popup — renaming it in place would have mislabeled that too. Added `updates`/`submissions`/
`activity`/`writeSubmission` keys.

"Notify regardless of tab" needed no new code: `comments/create-one.js`'s subscriber-notification
block (`sails.helpers.cards.getSubscriptionUserIds`) already fires unconditionally for every
comment row regardless of `type` — confirmed by reading the helper directly, not assumed.

Patch: `planka-custom/patches/0034-rename-tabs-submissions-exact-timestamps.patch`. **Deployed
and live-verified 2026-08-13** via `docker exec ... grep` (confirmed the built image actually
contained the new migration + client bundle strings before trusting any test), direct Postgres
inspection (`type` column present, all 432 pre-existing comments correctly defaulted to
`update`), and a headless-browser pass against an isolated sandbox card: confirmed tab order/
labels (`Updates, Submissions, Tasks, Activity`), Updates shown by default, a Submissions post
landing only in Submissions (not Updates) and vice versa, and the combined relative+absolute
timestamp rendering on both tabs and on Activity.

**Housekeeping note**: an early test-script bug in this session's own Puppeteer verification
(before the composer-textarea selector was fixed) left one stray sandbox project, `Tab Rename
Verify Sandbox` (id `1840516429321864924`), undeleted in production — the script threw before
reaching its own cleanup step. Flagged to the user rather than deleted via a DB-discovered ID,
per the standing rule that only session-tracked IDs get auto-cleanup. Deleted after explicit
user approval.

## Taiga import: re-running `--apply` clobbered a real staff card move (2026-08-13)

Client asked to invite the Yapmaster Media board's Taiga-referenced staff who'd signed up since
the last import. Re-ran `--apply` against the same `yapmaster media - 11082026.json` already
applied on 2026-08-11 — safe by design for that purpose (idempotent `getOrCreate` reused the
project/board/16 lists/187 cards/332 comments/57 attachments untouched, and correctly created
1 new board membership + 6 new card assignments for the users who'd matched since: 34/73 members
now match, up from 0/75 at initial import).

**But `apply()`'s per-card sync step is not idempotency-aware** — for any *reused* card, it force-
patches name/description/dueDate/**listId** to match the export whenever they differ from live
PLANKA, with zero regard for whether the live value is a stale export artifact or a **real staff
edit made since the last import**. This run silently reverted one card ("Most Disturbing Crimes
in the Dragon Ball Community") from "VO Ready for Editing" back to "Ready for VO" — undoing a
real move a staff member made the day before (2026-08-12, confirmed via the `action` table
alongside other genuine activity on that same card — task list created/deleted, members changed).
A second card ("Disturbing Crimes on Twitter") also got bumped into the `updated` count, but a
hash-comparison against that morning's 03:00 backup showed byte-identical content — a harmless
no-op patch, not a real revert (likely a description-serialization quirk that satisfies the naive
`!==` string check without an actual meaningful difference).

**How it was caught and fixed**: the daily `scripts/backup.sh` cron (3am) happened to have run
~2.5 hours before this apply, so the pre-apply DB state was recoverable — restored `planka.sql.gz`
from `/home/deploy/planka-backups/20260813-030001/` into a disposable throwaway Postgres container
(never touching production or the real restore path) to diff both flagged cards' fields against
current state. Confirmed via the `action` table's `moveCard` records (`data.fromList`/`data.toList`
survive intact) exactly which list the card had been in before the staff move, then moved it back
via a single explicit `PATCH /cards/:id`, with the user's explicit sign-off first — the permission
system correctly blocked the first attempt at this corrective write as an unconfirmed production
change I'd inferred on my own.

**Not yet fixed, flagged for later**: the underlying tool gap. `apply()`'s card-sync step
(`lib/framework.js`, the `if (cardRes.reused)` block) has no way to tell "export changed, sync it"
apart from "PLANKA changed since last import, leave it alone." Options if this needs to run again
before a real fix: (a) skip the sync entirely on a rerun and rely on `--dry-run`'s per-card diff
being reviewed by a human first (dry-run is currently naive/non-idempotency-aware too — see below,
would need fixing in tandem), or (b) compare each card's live `updatedAt` against the
`import_entities` row's timestamp from the last time *that specific card* was touched by this tool,
and skip the sync if the live card was modified more recently than that. Also worth fixing
separately: `planDryRun` (`lib/framework.js`) doesn't consult `import_entities` at all — it
describes the entire source file as if nothing were ever imported, so on a rerun its "Would
create/update" counts are meaningless and shouldn't be trusted as a preview of what `--apply` will
actually do (this was already known going in from the idempotent-`apply` design, but is worth
spelling out explicitly here since it nearly gave false comfort before this incident).

## Import tool hardening: card-sync skip, real-user comment attribution (2026-08-13)

Follow-up to the incident above, done same-day. Two asks: (1) actually implement the card-sync
guard flagged as "not yet fixed" above, so a rerun can no longer silently revert a live staff edit;
(2) make imported comments post as the real matched user instead of always the service account
(client's ask: "comments under each card have the users, not the invite service").

**Card-sync guard** (`lib/framework.js` `apply()`): implemented option (b) from the incident
note. `lib/db.js` gained `getEntityRecord()`, returning `updated_at` alongside `planka_id` — this
column already existed and was already being bumped correctly by `recordEntity`'s `ON CONFLICT`
branch, it just wasn't being read anywhere. Before patching a reused card, compare the live card's
`updatedAt` against `import_entities`'s `updated_at` for that card; if the live value is newer,
skip the sync entirely (bumped into a new `skippedSync` result bucket, surfaced in the apply
report) instead of overwriting, and bump the tool's own last-touch record on a *successful* sync so
future reruns compare against the sync, not the original creation time. Deliberately coarse: since
`comments/create-one.js` bumps `card.updated_at` on every comment (import-authored or not), this
also skips syncs that would've been perfectly safe — accepted tradeoff, a false-skip is recoverable
by hand, a silent revert isn't. Verified live against production immediately after deploying: the
Dragon Ball card (the one manually fixed after the original incident) correctly showed up in
`skippedSync` on the next `--apply` rerun instead of being reverted again.

**Real-user comment attribution**: `lib/planka-client.js`'s `request()` now supports an `apiKey`
option (sends `x-api-key`, per the server's `current-user` hook — a first-class auth mode, not a
workaround) alongside the existing `token` (Bearer) mode. Added `createUserApiKey()` (admin-only
`POST /users/:id/api-key`) and `deleteComment()`. In `apply()`'s comment-creation loop, an author
with a matched Planka account now gets a fresh, **in-memory-only** API key (never written to
`planka_ops` or disk — regenerated every run rather than persisted, so there's no standing user
credential sitting in our own database) and their comment posts as them with the original
unprefixed text; still-unmatched authors keep the old service-account + `[originally posted by X]`
prefix behavior. New `reauthorComments()` (`--reauthor-comments` CLI mode) retroactively fixes
already-imported comments the same way — **client explicitly chose this over a
future-comments-only scope**, accepting that Planka sets `createdAt` at recreation time, so the
original historical timestamp is not preserved for retroactively-fixed comments. Idempotent via a
`comment_reauthor` marker row per comment (same upsert pattern as everything else in this tool).

**Known tradeoff, not mitigated**: `createUserApiKey` overwrites/rotates whatever API key a user
already has — Planka only supports one active key per user. If any matched staff member had
separately generated their own personal API key for real automation, this silently invalidates it.
Flagged to the client as a real side effect of this design (not just a code comment) before running
it live; accepted as low-risk for this deployment's freshly-signed-up accounts, worth remembering
if that stops being true.

**A second, more serious bug found and fixed the same day, before it could compound**: the first
production run of `--reauthor-comments` deleted the old service-account comment *before* confirming
the new real-user comment was created. 8 of the run's comments failed to recreate — not because
anything was wrong with them, but because **a comment author isn't necessarily a card assignee**,
and `apply()`'s up-front board-membership grant was scoped only to `assigneeEmailsUsed`. An
unlisted comment author has no board access, so posting as them via their API key hit
`comments/create.js`'s non-member path, which throws a misleadingly-worded `Errors.CARD_NOT_FOUND`
("Card not found") that's actually a disguised Forbidden. Confirmed via direct count: the board's
comment total dropped from 332 to 326 - **real, confirmed data loss**, caught immediately via the
apply-result report's failure list rather than assumed.

Fixed two ways, both required together: (1) broadened the `assigneeEmailsUsed` set in `apply()`'s
up-front membership pass to also include every comment author, and added the same
`ensureBoardMembership` idempotent grant directly inside `reauthorComments()` too, so it's
self-sufficient and doesn't depend on an `apply()` run having happened first; (2) reordered
`reauthorComments()` to **create the new comment first, then delete the old one** — a create
failure now leaves the original untouched instead of losing it, and a delete against an
already-gone id (from a comment that hit the pre-fix bug on an earlier run) is caught and treated
as success, not a failure, since the goal state is already met.

Before touching production again, built a from-scratch regression harness (throwaway Postgres
container + a fully fake in-memory Planka client with *real* board-membership enforcement on
`createComment` — the first version of this harness didn't simulate that check at all, which is
exactly why it hadn't caught the bug in the first place) and ran 4 scenarios: apply() granting
membership to a comment-only (never-assignee) author; reauthor succeeding cleanly once membership
exists; reauthor being fully self-sufficient with zero net comment loss even when it has to grant
membership itself, mid-run, with no prior `apply()` pass. All passed before rerunning against
production. Recovery: took a fresh off-cycle backup first, reran the fixed `--reauthor-comments`,
which recovered exactly the 8 previously-failed comments (0 failures this time) with their original
text and correct attribution, verified byte-for-byte against a sample. Final board comment count:
334 (117 still-service-account for genuinely still-unmatched authors + 215 reauthored across both
runs = 332, the exact original Taiga total, plus 2 extra organic comments staff posted through the
live UI during the same window, confirmed via timestamp clustering and zero duplicate
`(card_id, text)` pairs — not an artifact of this process).

## Checklist (main TaskList) manual status field: To Do / In Progress / Completed (2026-08-13)

Client asked for a three-state workflow status on the **main checklist** (`TaskList`) — explicitly
not on sub-tasks (`Task`) — with a notification when it's toggled. Confirmed with the client up
front: notifications go to everyone subscribed to the card (not just the checklist's assignee),
the toggle lives both as an icon+popup in the checklist header and as a badge on the Kanban card
face, and it's manual-only (no auto-transition from sub-task completion % or from the pre-existing
`isDueCompleted` due-date flag, which is a different, unrelated concept).

- **Migration**: `status` (plain string, nullable, no backfill default) added to `task_list` —
  mirrors the most recent precedent (`20260813150000_add_type_to_comment.js`) except deliberately
  has no default value. Unlike `Comment.type` (which had an obvious backfill, `'update'`), there
  was no correct default status to silently assign every pre-existing checklist, so existing rows
  stay `null`/unset until a user explicitly picks one — same `allowNull: true`-with-no-default
  precedent `TaskList.isDueCompleted` already established. `TaskList.Statuses` const (`todo`/
  `inProgress`/`completed`, lower-camelCase values) exported the same way `Card.Types` is.
- **Notification mechanism reused, not rebuilt**: read `api/helpers/actions/create-one.js` live
  and confirmed exactly how `MOVE_CARD` already fans a notification out to every card+board
  subscriber with self-skip built in (`Action.INTERNAL_NOTIFIABLE_TYPES` branch, unions
  `sails.helpers.cards.getSubscriptionUserIds` + `sails.helpers.boards.getSubscriptionUserIds`,
  excludes the actor via the same call's second param) — this is a *different* branch from the
  single-targeted-recipient one `ASSIGN_TASK_LIST`/`ASSIGN_TASK` use
  (`Action.PERSONAL_NOTIFIABLE_TYPES`). The new `Action.Types.CHANGE_TASK_LIST_STATUS` was added
  to `INTERNAL_NOTIFIABLE_TYPES` only, deliberately **not** to `PERSONAL_NOTIFIABLE_TYPES` — the
  single highest-risk line in this change, since getting it backwards would've both broken the
  "notify everyone" requirement and thrown (the personal branch hard-requires
  `action.data.user.id`, which a status-change payload has no reason to carry). Verified directly
  against real DB rows: a subscriber got exactly one notification per real status change made by
  someone else, and zero when they made the change themselves (self-skip) or resubmitted the same
  value (no-op guard).
- **Real bug caught before shipping, not after**: the original plan was to also add `status` to
  `update-one.js`'s existing hardcoded `isLoggableChange` field list (the same one `name`/
  `startDate`/`dueDate`/`isDueCompleted` already use for the generic "updated checklist" Activity
  entry). Doing that would have logged **two** Action rows per status change — the generic
  `UPDATE_TASK_LIST` one, plus the new `CHANGE_TASK_LIST_STATUS` one — and the second would have
  rendered as a blank, content-less row in the Activity tab, since `ActivityTypes` (the client's
  Activity-tab rendering enum) never included `assignTaskList`/`assignTask` either, confirmed by
  reading `CardActivities/Item.jsx`'s `default: contentNode = null` fallback. Fixed by *not* adding
  `status` to `isLoggableChange` (matching the pre-existing `assigneeUserId` exclusion, which has
  the same reasoning) and instead giving `CHANGE_TASK_LIST_STATUS` its own real
  `ActivityTypes`/`CardActivities/Item.jsx` case — one Action row now serves double duty as both
  the notification trigger and a proper, single, informative Activity-tab entry ("X changed
  checklist Y status to Z" / "X cleared the status of checklist Y"), the same pattern `MOVE_CARD`
  and `COMPLETE_TASK` already use. Verified live: exactly one clean Activity-tab row per status
  change, no blank duplicates.
- **Client UI**: checklist header (`CardModal/TaskLists/Item.jsx`) gained a 4th always-visible
  editor icon (was assignee+dates+pencil, now status+assignee+dates+pencil — `visibleActionsCount`
  padding-class progression extended to a new `.five` at 152px, continuing the existing
  `.two`/`.three`/`.four` +30px-per-icon pattern), opening a new `SelectStatusStep.jsx` (mirrors
  `GanttModal/GanttChart/ColorPickerStep.jsx`'s Popup.Header/Content + clear-button shape, but a
  labeled 3-row list instead of a color-swatch grid). Non-editors see a plain read-only dot only
  when a status is actually set, same rule the assignee avatar already follows. Card face
  (`Card/TaskList/TaskList.jsx`, shared by both Project- and Story-type cards, confirmed via the
  2026-08-10 story-card-face-checklists fix) gained a small colored badge next to the checklist
  name, shown only when the checklist has ≥1 sub-task (the same existing `tasks.length === 0 →
  render nothing` gate the progress bar itself already has — there's nowhere to put a badge "next
  to the progress bar" when there is no progress bar). Fixed 3-color legend
  (`constants/TaskListStatusColors.js`: grey/blue/green) reuses hex values already present in
  `GanttTaskListColors.js` rather than inventing new ones.
- **No client saga/API/reducer changes needed** — `entryActions.updateTaskList(id, { anyField })`
  was already fully generic (proven by patch 0029's `assigneeUserId` usage), so the new `status`
  field just rides the existing update path; only `status: attr()` was added to the client
  `TaskList` model. Deliberately excluded from `TaskList.duplicate()`, matching how
  `startDate`/`dueDate`/`isDueCompleted`/`assigneeUserId` are already excluded there — a duplicated
  checklist shouldn't inherit the original's in-flight workflow state.

Patch: `planka-custom/patches/0035-checklist-status-field.patch`. **Deployed and live-verified
2026-08-13** end-to-end in an isolated sandbox project (created and fully deleted via the API
afterward, confirmed zero trace left in `project`/`board`/`card`/`task_list`/`user_account`/
`action`/`notification`): real Postgres checks confirmed exactly one `changeTaskListStatus` Action
row per genuine change and zero for a same-value resubmit; a subscribed second user received
exactly one notification per change made by someone else and zero for their own changes; a
non-editor board member got a real 403 attempting the same API call, proving the existing
board-editor gate covers the new field automatically; a headless-browser pass confirmed the header
popup, the card-face badge, the notification-bell text, and the Activity-tab entry all render
correctly, and — the most important regression check given the explicit scoping requirement —
confirmed the status control never appears on `Task` (sub-task) rows, only on the parent
`TaskList` header. Also regression-checked against real production data (the "Yapmaster Media"
board's existing "Scriptwriting"/"Video Editing" checklists, which already carry real dates/
assignees/colors from prior sessions) and the Gantt Timeline tab — both rendered correctly
alongside the new status icon with no visual or functional breakage, and zero rows were touched in
the unrelated `planka_ops.gantt_task_list_colors` table.

### Redesign: cycling label chip instead of a popup, black/yellow/green palette (2026-08-13)

Client feedback on the first cut, same day: the checklist-header control should be a clickable
**label**, not a dot, and shouldn't open a menu at all — clicking it should directly **cycle**
through states (default "Not Set" → To Do → In Progress → Completed → back to Not Set), with a
small delete icon conjoined to the label as a shortcut straight back to Not Set from any state.
Colors: Not Set grey (default/unset), To Do black, In Progress yellow, Completed green — and the
**opposite** swap on the card face: no text there, just a small colored dot next to the progress
bar (the reverse of what the header now does).

- **`SelectStatusStep.jsx`/`.module.scss` deleted outright** (dead code once the popup approach
  was dropped, not kept around commented-out) — `CardModal/TaskLists/Item.jsx`'s status control is
  now self-contained: `handleStatusClick` advances a `STATUS_CYCLE = [null, todo, inProgress,
  completed]` array by index and wraps with `%`; `handleStatusDeleteClick` sets `status: null`
  directly, `event.stopPropagation()`'d so it doesn't also trigger the label's own cycle-click
  (they're conjoined in the same `.statusChip` flex wrapper).
- **Header padding switched from discrete step classes to a computed inline style.** The prior
  `.two`/`.three`/`.four`/`.five` fixed-30px-per-icon system (removed) assumed every action is a
  fixed-width 28px icon button; the status chip is now variable-width text, so
  `Item.jsx` computes `actionsWidth = (showStatusChip ? STATUS_CHIP_WIDTH : 0) + iconCount *
  ICON_WIDTH` and applies it directly via `style={{ paddingRight }}`, keeping the other icons
  (assignee/dates/pencil/hide-toggle) on the original 30px-per-icon budget.
- **Editors always see the chip, including at "Not Set"** — needed as the click target to start
  the cycle from scratch; non-editors only see it (read-only, no button/delete icon) once a real
  status is set, same visibility rule the assignee avatar already used. `common.taskListStatus_
  notSet` replaces the old `common.taskListStatus_title` popup-header key (no popup left to title).
- **Card face reverted to a dot** (`Card/TaskList/TaskList.jsx`/`.module.scss`): the `.nameRow`
  wrapper added for the text badge was removed, `.name` restored to its original single-element
  layout, and a `.statusDot` span (10px circle) now sits at the start of `.progressRow`, colored
  the same way the header chip is, with a `title` tooltip carrying the status text for anyone who
  wants it without opening the card.
- **Palette** (`constants/TaskListStatusColors.js`): client's literal choice, not derived from the
  app's existing color language this time - `todo: '#000000'` (black), `inProgress: '#e2b203'`
  (yellow/gold), `completed: '#4bce97'` (green, unchanged from the first cut), plus two new
  standalone exports (`TASK_LIST_STATUS_NOT_SET_COLOR: '#dfe1e6'` grey and matching text-color
  constants) for the "Not Set" default, which isn't a stored enum value so it can't live in the
  same status-keyed map as the other three.
- **Server unchanged** — this was purely a client-side UI/UX revision; the `status` column, API
  validation, notification fan-out, and Activity-tab logging from the same day's earlier session
  all carried over as-is (still `null`/`todo`/`inProgress`/`completed`, still routed through
  `Action.INTERNAL_NOTIFIABLE_TYPES`).
- **Kanban card-face dot given a thin white outline** (same-day follow-up ask, right after the
  redesign): `box-shadow` extended from just the existing subtle inset border to also include a
  `0 0 0 1.5px #fff` outer ring, so the dot (especially the pure-black "To Do" state) stays legible
  against colored/dark board backgrounds instead of blending in.

Patch: `planka-custom/patches/0035-checklist-status-field.patch` (rewritten in place - this
superseded the popup-based first cut before it was ever used in production, so no migration/data
concern, just a client bundle rebuild). **Deployed and live-verified 2026-08-13** via a headless
browser: clicking the label cycles Not Set → To Do → In Progress → Completed → Not Set with zero
popups at any step (explicitly checked `document.querySelector('.ui.popup')` after every click);
the delete icon jumps directly from a mid-cycle state (tested from "In Progress") straight back to
Not Set without visiting To Do/Completed first; label colors match the black/yellow/green/grey spec
with readable text on each; sub-task rows still show no status control at all. Regression-checked
again against the real "Yapmaster Media" board's existing checklists (now correctly showing grey
"NOT SET" chips, since their status has never been touched) and the Gantt Timeline tab, both
unaffected. Sandbox project/board fully deleted afterward, confirmed via direct Postgres count.

## Deadline notifications, due-status coloring, date-chip colors, remove card-level dates (2026-08-13)

Follow-up to a plain question ("what happens when a task's deadline is approaching? any visual
cues, any notifications?") that surfaced a real gap: this app had zero time-based notifications
(only mutation-triggered ones) and the only due-date visual cue lived on small chips *inside* the
opened card, invisible from the board. Four related changes landed together:

1. **A real scheduled deadline-notification system** - pings the assignee when a checklist/
   sub-task crosses <24h from its due date ("due soon"), and again when it becomes overdue.
2. **Card-face title coloring** - a checklist/sub-task's own name text turns orange (due soon) /
   red (overdue) directly on the Kanban board card face, including sub-tasks when the card's
   expand arrow is open, so urgency is visible without opening the card.
3. **Date-chip base colors** - the small start/due chips inside the card modal now use fixed
   identity colors (blue start, orange due, matching the calendar picker) as their resting state,
   with the existing overdue-red/completed-green status override still taking priority.
4. **Card-level dates removed entirely** - the card's own separate start/due date feature (distinct
   from checklist/task dates) was dropped from the UI and API. Confirmed via a real DB check before
   touching anything: 31 production cards had `due_date` set, so removal was scoped **non-
   destructive** - UI/API surface only, the `card.start_date`/`due_date`/`is_due_completed` columns
   stay in the database, unused and untouched (re-confirmed identical count, 31/231, after shipping).

### Feature 1 - scheduled hook (new pattern for this codebase)

No cron/scheduling library exists anywhere in this app - confirmed via `server/package.json` - so
the new `server/api/hooks/deadline-notifications/index.js` mirrors the *only* existing recurring-
task precedent, `watcher/index.js`'s bare `setInterval` (60s), calling two new helpers,
`server/api/helpers/deadline-notifications/process-{task-lists,tasks}.js`. Two new nullable
timestamp columns per model (`last_due_soon_notified_at`/`last_overdue_notified_at` on `task_list`
and `task`, migrations `20260813180000`/`20260813180001`) track idempotency - reset to null in
`task-lists/update-one.js`/`tasks/update-one.js` whenever `dueDate` or `assigneeUserId` changes, so
a postponed deadline or a newly-assigned user gets a fresh notification cycle. Delivery reuses the
existing `Action.PERSONAL_NOTIFIABLE_TYPES` single-recipient pathway (same one `ASSIGN_TASK_LIST`/
`ASSIGN_TASK` already use) - four new types, `TASK_LIST_DUE_SOON`/`TASK_LIST_OVERDUE`/
`TASK_DUE_SOON`/`TASK_OVERDUE`. Since a scheduled job has no real "actor," the bootstrap admin
account (`sails.config.custom.defaultAdminEmail`) is used purely to satisfy `Notification.
creatorUserId`'s schema requirement - the client renders these 4 types with deliberately impersonal
wording ("Checklist «X» is due soon on «Card»") and, critically, **does not show the admin's
avatar either** (`NotificationsStep/Item.jsx` was found to unconditionally render `<UserAvatar
id={notification.creatorUserId} .../>` outside the per-type switch - fixed by swapping in a neutral
orange/red hourglass icon for these 4 types specifically, matching the due-soon/overdue color
language, so the "no sender shown" intent is actually true end-to-end, not just in the text).

**Two real bugs found and fixed during live verification, not caught by code review alone:**
- **Waterline's `{ '!=': true }` on a nullable boolean silently excludes `NULL` rows** (plain SQL
  three-valued logic - `NULL != true` is unknown, not true) - `isDueCompleted` is `allowNull: true`
  and the overwhelming majority of real rows have it as `null`, never `false`, so the original
  due-soon/overdue queries matched **zero** real checklists despite objectively-matching test data
  (confirmed by directly comparing the Waterline query result against an equivalent raw-SQL check
  during verification - the row satisfied every condition by eye, `TaskList.find()` still returned
  empty). Fixed in both `TaskList.qm.getOverdue`/`getDueSoon` and the `Task.qm` equivalents by
  replacing `isDueCompleted: { '!=': true }` with `or: [{ isDueCompleted: false }, { isDueCompleted:
  null }]`.
- **`Trans` component child-index miscounting**: the 4 new notification cases render `[plain-text-
  string, <Link>]` as children (no leading `<span className={styles.author}>` since these are
  impersonal) - the i18n strings were written as `<0>{{card}}</0>`, but react-i18next's `Trans`
  counts *every* child including plain text nodes toward the numeric index, confirmed directly
  against the working `ASSIGN_TASK_LIST` precedent (`<0>{{user}}</0> ... <2>{{card}}</2>`, where
  index 1 is exactly this kind of in-between plain-text child) - the Link was actually at index 1,
  not 0. Manifested as garbled, duplicated notification text in the live UI ("Checklist «X» is
  overdue on Checklist «X» is overdue on") until caught by an actual headless-browser screenshot of
  the notification bell, not just a DB/API check. Fixed by correcting all 4 new i18n keys to `<1>`.

Both bugs were caught only because verification went all the way to a real browser screenshot and
a live-running scheduled interval, not just "the helper function ran without throwing" - consistent
with this deployment's own standing rule to verify live, not just claim it works.

Live-verified end-to-end in an isolated sandbox (fully deleted afterward, confirmed via direct
Postgres count): due-soon and overdue each fire exactly once (idempotency confirmed across a full
extra interval tick with zero DB changes), a `PATCH` via the real API resets tracking, a deactivated
assignee is silently skipped with no error, and the real running `setInterval` (not just a manual
helper invocation) picks up a reset row within one tick.

### Feature 2 - card-face title coloring

Extracted the due-soon/overdue/completed threshold math (previously only living inside
`DueDateChip.jsx`'s local `getStatus()`) into a shared `client/src/utils/get-due-date-status.js`,
and its live-updating `setInterval`-based re-render logic into a shared `client/src/hooks/
use-due-date-status.js` - both `DueDateChip` and the new card-face coloring (`Card/TaskList/
TaskList.jsx` for the checklist name, `Card/TaskList/Task.jsx` for the sub-task name shown when
the card's expand arrow is open) consume the same one implementation instead of a third copy of the
24-hour math. Colors reuse `DueDateChip`'s own existing hex values exactly (`#f2711c`/`#db2828`) for
consistency - live-verified via `getComputedStyle` matching pixel-for-pixel, not just "looks
orange." `Task.module.scss`'s existing dark-mode-cards override block (`:global(#app.dark-mode-
cards-enabled) .name:not(.nameCompleted)`, id-qualified) needed matching double-class overrides
added, or its higher specificity would have silently washed out the new plain classes in dark mode.

### Feature 3 - date-chip base colors

`DueDateChip.jsx` gained one additive prop, `baseColor` (`'neutral'` default, unchanged for every
untouched call site, or `'blue'`/`'orange'`) - when an active due-soon/overdue/completed status
exists, the existing status classes still win (this *is* "status overrides base color"); otherwise
the chip falls back to the new base color instead of always-grey. Only the checklist-header
(`CardModal/TaskLists/Item.jsx`) and sub-task (`task-lists/TaskList/Task/Task.jsx`) date chips were
updated - Gantt's Schedule/Tasks/Timeline chips stay neutral (out of scope, unaffected by the new
default). Live-verified all 4 states on one real chip in sequence: solid blue start, solid orange
due (far-future, base color), solid green (marked `isDueCompleted`) - confirmed distinct from the
base orange, matching `DueDateChip`'s pre-existing status-color values exactly.

### Feature 4 - card-level dates removed (non-destructive)

Full removal swept server (`Card.js` model attributes, `cards/{update,create}.js` controllers,
`cards/{update-one,create-one,duplicate-one}.js` helpers, the `SET_CARD_START_DATE`/
`SET_CARD_DUE_DATE` Action types, `boards/import-from-trello.js`'s Trello-date import - flagging
this as a genuine behavior change, future Trello imports no longer bring in card due dates) and
client (`models/Card.js`, `api/cards.js`'s transform layer, `Card/ProjectContent.jsx` card face,
the entire "Dates" sidebar section in `CardModal/ProjectContent.jsx`, the `cardId` mode of the
shared `EditDueDateStep.jsx`, `CardActivities/Item.jsx`'s activity cases). `CardModal/
StoryContent.jsx`/`Card/StoryContent.jsx` needed no changes - confirmed via direct read they never
had card-date UI. Kept `common.startDate`/`common.dueDate` i18n keys (also used by `EditDueDateStep`'s
still-live tab labels) while removing the 4 now-dead `userSet.../userRemoved...` activity-text keys
- caught by grepping for other usages before deleting anything, not assumed safe.

**Two real gaps found via a from-scratch grep sweep, missed by the initial research pass:**
- **`CardActionsStep.jsx`** (the board-level card 3-dot menu) had its own, separate "Edit Due Date"
  menu item + `EditDueDateStep cardId={...}` step, entangled into a shared `menuItemsTotal`/
  `hasTopSection` layout-counting calculation alongside several unrelated `can*` flags - removed
  cleanly by deleting just the `canEditDueDate`-gated contributions, not touching the others.
- **The Gantt "Tasks" tab (`Tasks.jsx`)** genuinely has its own card-level date UI (`item.
  startDate`/`dueDate`, a date-chip row, `EditDatesPopup cardId={item.cardId}` wrapping the card
  header) - this directly contradicted an initial assumption (carried from a first-pass read) that
  it was already checklist-only like `Timeline.jsx`; caught by reading the file directly rather
  than trusting the earlier summary, matching this deployment's own repeated "verify, don't trust a
  summary" lesson.
- Also found and removed a **third, unrelated exposure of card due dates**: a list's own "Sort by
  due date" feature (`SortStep.jsx`'s `Types.BY_DUE_DATE`, `List.SortFieldNames.DUE_DATE` on both
  client and server, `lists/sort-one.js`'s sort comparator) - not part of the Gantt modal at all,
  found only via a final broad `grep` sweep for `card.*dueDate` patterns across the whole tree
  after believing the removal was complete. A genuine instance of "safely remove any instances of
  that in the code" that the itemized plan hadn't enumerated.

`GanttChart/Row.jsx`/`GanttChart.jsx`'s `cardId` prop plumbing (feeds `EditDueDateStep` for a
card-level bar click) was also fully removed, not just left as harmless dead weight - confirmed via
grep that no row-building code (`Timeline.jsx`, `TeamWorkload.jsx`) ever populated a real `cardId`
on a row object after the Feature 4 changes (only used it for React `key` strings), so the prop
could never carry a real value again.

Patch: `planka-custom/patches/0036-deadline-notifications-status-coloring-remove-card-dates.patch`.
**Deployed and live-verified 2026-08-13**, all in one isolated sandbox (project/board/throwaway
user fully deleted afterward, confirmed via direct Postgres count returning zero across every
table touched): due-soon/overdue notification firing + idempotency + reset-on-change + deactivated-
user-skip, all 4 real hex color states on the date chips, card-face title coloring on both a
checklist and its sub-task independently, a direct `PATCH /api/cards/:id` with `dueDate` in the
body silently ignored (200, not 400, value never persisted), and a full regression pass against the
real "Yapmaster Media" board's existing checklists and all 4 Gantt tabs (Timeline/Tasks/Team
Workload/Schedule) - zero visual or functional breakage, confirmed via live screenshots not just
"the build succeeded." Final real-data check: still exactly 31/231 cards with `due_date` set,
byte-for-byte the same count as before this work started.

## Gantt Timeline density/refinement round (2026-08-14)

Follow-up round on the shared `GanttModal/GanttChart` renderer (used by both the Timeline and Team
Workload tabs). The bones from the prior rounds (0031-0033) were right - bars, labels, today
marker, Day/Week/Month zoom, weekend/month shading, sticky-positioned header/label CSS - but the
chart still felt sparse and some of that CSS wasn't actually taking effect in practice. Six
concrete fixes, plus one explicit removal:

- **Smart default scale** - `GanttChart.jsx` used to hardcode `useState('day')`. New
  `getDefaultScaleKey(rows)` computes the *raw* min/max span across all row dates (unclamped by any
  scale's own `minRangeDays`) and picks Day (<=21 days), Week (<=120 days), or Month (>120 days) as
  the initial `useState` lazy initializer - so a board whose dated checklists span months no longer
  opens to a near-empty 14-day window at 32px/day.
- **Row density** - `.row` went from a fixed `height: 36px` to `min-height: 26px` (with `height:
  auto`, so a wrapped long label can still grow a specific row without disturbing any other row's
  bar geometry - rows stack in normal flow, and the month/weekend-shade/today-line overlays are
  `.body`-relative, not per-row). Bar height 20px -> 16px, `top: 8px` -> `top: 50%; transform:
  translateY(-50%)` (needed once row height became variable, so a bar always self-centers instead
  of relying on a row-height constant baked into a fixed `top`).
- **Wider label column, real wrapping** - `LABEL_WIDTH` 260px -> 320px; `.labelText` dropped
  `-webkit-line-clamp: 2` (which was hard-truncating a long title's third+ line with an ellipsis)
  in favor of plain `white-space: normal` wrapping with no line cap.
- **Weekend/month shading intensified slightly** - already existed from 0032, just bumped from
  `rgba(9,30,66,0.03/0.05)` to `0.045/0.07` for better visibility; no structural change needed.
- **Sticky headers - found and fixed a real bug, not just a tuning pass.** `GanttChart.module.scss`
  already had `.header`/`.headerLabel`/`.label` all set to `position: sticky` - but
  `GanttModal.module.scss`'s outer Semantic `Tab` pane wrapper also had `overflow: auto`, making
  it, not GanttChart's own `.scroller`, the browser's chosen "nearest scrolling ancestor" for
  sticky purposes on Timeline/Team Workload. Fix: outer `:global(.tab)` -> `overflow: hidden`, so
  `.scroller` becomes the sole scroll container everywhere. Since Schedule.jsx/Tasks.jsx (the other
  2 Gantt tabs) have no inner scroller of their own and relied entirely on that outer `overflow:
  auto` to scroll their own (potentially long) list content, both gained their own `height: 100%;
  overflow-y: auto` on `.wrapper` first, confirmed via direct read of both files' `.module.scss`
  before making the outer change, so this wasn't a blind global flip.
- **Full-height today marker** - `.todayLine`'s `top: 0; bottom: 0` inside `.body` (position:
  relative) was already correct; it only *looked* like it stopped at one bar because the live test
  board had exactly one dated checklist at the time. Live-verified with 8 populated rows: today
  line height matched the full `.body` height (224px), not a single row's height (26px).

**Removed entirely, per explicit instruction ("no need for a checklist color selector - use the
deadline colors"):** the Tier-3 per-checklist manual color picker (`ColorPickerStep.jsx` + its
`.module.scss`, `constants/GanttTaskListColors.js`, the `invite-service`-backed `fetchColors`/
`saveColor`/`colors` state in `Timeline.jsx`, `onColorChange`/`color` prop plumbing through
`GanttChart.jsx`/`Row.jsx`). Replaced with automatic deadline-status coloring: `Row.jsx` now calls
the same shared `getDueDateStatus()` (from `utils/get-due-date-status.js`, the utility already
extracted for the card-face title-coloring feature) and maps `OVERDUE`/`DUE_SOON`/`COMPLETED` to
the exact same hex values used everywhere else in the app (`#db2828`/`#f2711c`/`#4bce97`), falling
back to the pre-existing blue-start/orange-due gradient/solid coloring when no status applies. This
needed `isDueCompleted` threaded onto every row object in both `Timeline.jsx` and `TeamWorkload.jsx`
(previously only `startDate`/`dueDate` were passed) since the status calculation needs it. Also
removed the now-orphaned `checklistColor_title` i18n key (grepped first to confirm no other call
site referenced it - `action.removeColor` stayed, shared with `lists/List/EditColorStep.jsx`).

**Live-verified end to end** (5 throwaway checklists created via the real API on a real board card,
one each: overdue, due-soon <24h, normal future dated with a deliberately 128-char-limit-testing
long name, far-future for Month-scale testing, and `isDueCompleted: true` - all deleted via the API
afterward, confirmed 200 on each delete): default scale correctly landed on Month for a ~130-day
spread; row height measured 26px; label column measured 320px; the long title wrapped to 2 lines
inside the label instead of truncating; 6 month-shade bands rendered; today-line height matched the
full 8-row body (224px) not a single row; bar colors matched exactly -
`rgb(219,40,40)`/overdue, `rgb(242,113,28)`/due-soon, `rgb(75,206,151)`/completed, blue-to-orange
gradient for plain dated rows; zero `colorSwatch` elements remained on Timeline; zero console
errors on Timeline or Team Workload. Confirmed via computed style (not just visual inspection) that
the real GanttChart header (`.header`) and row label (`.label`) both report `position: sticky` (an
early check mis-fired by matching an unrelated Semantic UI element also named `.header` in the DOM
- corrected by disambiguating on a Gantt-specific sibling class before trusting the result).

Patch: `planka-custom/patches/0037-gantt-timeline-density-refinements.patch`.

## Gantt modal full-width fix + spacing polish (2026-08-14)

Immediate follow-up: the Gantt modal wasn't actually covering the full window width - a
permanent gap sat flush against the right edge. Root cause found via direct inspection of the
live page's applied stylesheets (`document.styleSheets`, not guessing): Semantic UI's own built-in
rule is `.ui.fullscreen.modal { margin: 1em auto; width: 95% !important; left: 0px !important; }`.
The `left: 0 !important` pins the box's left edge while `width: 95%` leaves the remaining 5% (96px
at 1920px wide) stuck on the right - `margin: auto` never gets a chance to center it because
`left` is forced. Fixed with a single higher-specificity override in `GanttModal.module.scss`:
`:global(#app) :global(.ui.fullscreen.modal) { width: 100% !important; }` (2 classes + 1 ID beats
Semantic's 2-class rule, no need to touch the component itself). Live-verified via
`getBoundingClientRect()`: modal width now measures exactly the window's `innerWidth` (1920px ==
1920px), where it previously measured 1824px.

Also added general breathing room per explicit feedback ("spaced out and easier to look at"),
since the prior round's density pass (0037) had gone tight enough to feel cramped once the
chart actually had room to spread out: `.wrapper` gained horizontal padding, the toolbar's
bottom padding grew (8px -> 14px), month/day header cells got slightly larger font/padding, and
`Row.module.scss`'s row `min-height` went 26px -> 32px (bar height 16px -> 18px, label padding
12px -> 16px) - still meaningfully denser than the original 36px/20px round, just not knife-edge
tight now that width is no longer the constraint it was.

Patch: `planka-custom/patches/0038-gantt-fullwidth-spacing.patch`.

## Gantt chart stretch-to-fill (2026-08-14, same day)

Clarifying follow-up: 0038 fixed the *modal* to span the full window, but the calendar grid
*inside* it still didn't - measured live at 1920px wide, the modal/scroller correctly filled to
1904px available, but the actual rendered grid (`.inner`, label column + day/week/month columns)
only came out to 768px (Day), 1160px (Week), or 1415px (Month), leaving several hundred px of
blank white space stranded to the right of the last date column. Root cause: `dayWidth` was a
flat per-scale constant (32/10/3 px) - `chartWidth = totalDays * dayWidth` had no relationship to
the container's actual size, so a data span short enough to fit inside `minRangeDays` just... ran
out of columns before running out of screen.

Fix in `GanttChart.jsx`: a `ResizeObserver` on `scrollerRef` tracks the scroller's live
`contentRect.width` in `containerWidth` state. A new `dayWidth` (renaming the old per-scale
constant to `baseDayWidth`) is derived: if `containerWidth - LABEL_WIDTH` (the space actually
available for the grid) is wider than `totalDays * baseDayWidth` (what the grid would naturally
need), stretch each day's width up to fill it exactly (`availableChartWidth / totalDays`);
otherwise fall back to `baseDayWidth` unchanged and let the scroller handle genuine horizontal
overflow as before. Every downstream consumer (day/week header cells, month/weekend shade bands,
the today line, `Row.jsx`'s bar geometry via its `dayWidth` prop, the scroll-to-today effect) reads
this same derived `dayWidth`, so the whole grid stretches or scrolls as one coherent unit - no
separate "visual" vs. "geometry" width to keep in sync.

Live-verified via `getBoundingClientRect()`/`clientWidth` at 1920px: `.inner` now measures exactly
1904px (== the scroller's own `clientWidth`) at Day, Week, *and* Month scale, where it previously
measured 768/1160/1415px respectively. Confirmed with real screenshots at all 3 scales and a
console-error sweep across all 4 Gantt tabs x all 3 scales (12 combinations, zero errors).

Patch: `planka-custom/patches/0039-gantt-stretch-to-fill-width.patch`.

## Gantt round 5: day/week shading, status-aware bar colors, vertical zoom, Team Workload scroll fix, inline toggle (2026-08-15)

Five more client-requested changes to the board Gantt view, on top of `0028`-`0039`:

1. **Alternating day/week bands.** `GanttChart.jsx`'s alternating shade (`index % 2 === 1`) used
   to always be month-sized regardless of zoom - only Month scale actually looked "regularly
   spaced." Added `dayShadeSegments`/`weekShadeSegments` (same pattern as the existing
   `monthShadeSegments`, `weekSegments` gained the `dayOffset` field it was missing) and a
   `bandSegments` switch keyed on `scaleKey`, so Day/Week scale now shade by their own unit. CSS
   class renamed `.monthShade` -> `.bandShade` (scale-neutral now). Weekend shading is unchanged,
   still layered on top.
2. **Status-aware bar colors, deadline still wins (confirmed with client).** `Row.jsx` gained a
   4th precedence tier: `OVERDUE` -> `DUE_SOON` -> `isDueCompleted` (green) -> **`TaskList.status`
   color** (`constants/TaskListStatusColors.js` - same black/yellow/green palette as the checklist
   header chip, reused not duplicated) -> the existing blue/orange gradient fallback. `status` had
   to be threaded onto row objects for the first time - `selectors/gantt.js` didn't actually expose
   it yet despite the field existing on the model (caught by grepping before trusting the plan's
   assumption), then `Timeline.jsx`/`TeamWorkload.jsx`/`GanttChart.jsx` each pass it through to
   `Row`. Sub-task rows have no `status` field (only `TaskList` got one in `0035`) - they fall
   straight through to the gradient tier unchanged.
3. **Vertical zoom.** New `+`/`-` toolbar buttons cycle a row-height preset ladder via a
   `--row-height` CSS custom property (set once on `GanttChart.jsx`'s `.body`, consumed by
   `Row.module.scss`'s `.row` min-height and `.bar`/`.barButton` height via `calc()`). **Real bug
   caught during live verification, not code review**: the first ladder (`20-64px`) had a dead
   floor - `.label`'s fixed 12px padding + 14px line-height forces a real ~26px minimum, so 20px
   silently never rendered even though the state/disabled-button correctly reached it. Fixed by
   starting the ladder at 26px (the exact density this app already shipped and lived with in the
   2026-08-14 round) instead of inventing an unreachable lower bound.
4. **Team Workload bottom-row cutoff, real bug.** `Timeline.jsx`/`TeamWorkload.jsx` wrap
   `GanttChart` in *identical* CSS - not a Team-Workload-specific difference - it just has far more
   rows in practice, long enough to expose that the shared `.body`/`.scroller` had zero bottom
   padding, so the last row sat flush against the scroll edge (and any horizontal scrollbar).
   Fixed with `padding-bottom: 24px` on `.body`, shared by both tabs.
5. **Inline board-area toggle, replacing the fullscreen modal.** Clicking Gantt now swaps
   `Board.jsx`'s `Content` slot (same one `KanbanContent` occupies) for a new un-modaled
   `GanttView` component, instead of opening `GanttModal` as an overlay; the button flips into a
   "Board" button (`common.board` i18n key, already existed) to switch back. New `isGanttViewActive`
   client-only flag mirrors the existing `isEditModeEnabled` pattern exactly (`reducers`/`actions`/
   `entry-actions`/`sagas/core/services`+`watchers`/`selectors` all touched, same shape), reset to
   `false` on board switch via the same `LOCATION_CHANGE_HANDLE` branch that already resets
   `recentCardId`. `GanttModal.jsx` (and `ModalTypes.BOARD_GANTT`/`openBoardGanttModal`) deleted as
   dead code - `Timeline`/`Tasks`/`TeamWorkload`/`Schedule` stayed in place under `GanttModal/` and
   are imported by the new sibling `GanttView/`, not moved/duplicated.
   - **Real coupling handled, not accidentally broken**: `Row.jsx`/`Tasks.jsx`/`Schedule.jsx`'s
     click-to-edit date popups depend on `ClosableContext`, which `GanttModal` used to provide for
     free bundled with its `useClosableModal()` Modal wrapper. `GanttView` calls the lower-level
     `useClosable()` hook directly (the same one `useClosableModal` itself calls) and provides the
     identical 3-value context shape with no Modal involved - confirmed live that clicking a bar
     still opens the Dates popup correctly, not just that nothing crashed.
   - **Two real layout bugs found only via live verification after the first deploy, both reported
     directly by the client** (not caught by static review or the pre-deploy build): (a) the new
     `.wrapper` is a flex item of `Board.jsx`'s own row-direction content slot
     (`Static.module.scss`'s `.wrapper.wrapperBoard.wrapperFlex`) and was missing `flex: 1 1 auto`,
     so it only claimed its own content's natural width - confirmed live via
     `getBoundingClientRect()`, 912px instead of the full 1600px viewport, before the fix. (b) that
     same content slot's ambient height is *deliberately* taller than the viewport for Kanban's sake
     (a fixed header-height `margin-top` meant to let the *page* scroll, since Kanban's own content
     never needed one bounded internal scroller) - `GanttView`'s wrapper was inheriting that same
     oversized height via flex cross-axis stretch, causing a second, redundant page-level scrollbar
     on top of the chart's own `.scroller`. Fixed by measuring the wrapper's real
     `getBoundingClientRect().top` in a `useEffect` (recomputed on window resize) and setting an
     explicit pixel height - the same ResizeObserver-driven "measure and set an explicit style"
     pattern `GanttChart.jsx` already uses for its own horizontal stretch-to-fill fix, since there's
     no pure-CSS "100vh minus wherever I actually ended up" primitive here (the true offset varies
     by favorites-panel state and the promo banner, so a hardcoded `calc()` constant - what the old
     fullscreen modal did - would've been wrong in at least one of those states).

Patch: `planka-custom/patches/0040-gantt-shading-status-colors-vzoom-scroll-fix-inline-toggle.patch`.
**Deployed and live-verified 2026-08-15** in an isolated sandbox project (created and fully deleted
via the API afterward - board and project delete both confirmed 200): all 7 bar-color precedence
combinations (overdue+status, due-soon+status, future+each status, gradient fallback,
overdue+isDueCompleted+status) rendered the exact expected hex/gradient values via
`getComputedStyle`; Day/Week/Month band counts and pixel alignment confirmed at every scale; zoom
ladder confirmed to respect its real 26-64px bounds (button disables exactly in sync with the
row height actually reaching each end, re-checked step-by-step after the floor fix); Team
Workload scrolled to bottom shows a real ~24px gap between the last row and the scroller edge;
toggling Gantt on/off swaps content and button label/icon correctly both directions, with the
Kanban board's own state intact after toggling back; clicking a bar opens the Dates popup
correctly. Zero console/page errors across the full pass.

### Round 5 follow-up: bigger scroll buffer, hide empty Team Workload members, label/chart divider (2026-08-15, same day)

Direct client feedback right after the round-5 deploy - the last-row cutoff was still visible
despite the 24px `padding-bottom` fix above, plus two new asks:

- **Scroll buffer bumped 24px -> 60px** on `GanttChart.module.scss`'s `.body` - the mechanism was
  already correct (confirmed via a real `getBoundingClientRect()` gap measurement before this
  change), the client just wanted more unmistakable breathing room than 24px gave.
- **Team Workload no longer shows members with zero scheduled items at all** - previously every
  board member got a group header even with nothing under it (a "No scheduled items" placeholder
  row). `TeamWorkload.jsx`'s row-building loop now accumulates each member's rows into a local
  scratch array first and only splices the header + rows into the real result once
  `memberRows.length > 0`; `isGroupBoundary` is computed against the real result's length so
  boundary borders still land correctly with members skipped. Removed the now-dead
  `common.noScheduledItems` i18n key and `.emptyLabel` style along with the only place that used
  them.
- **2px divider line** (`#c1c7d0`, a standard Trello-style medium grey) between the sticky label
  column and the chart track - added as `border-right` on both `GanttChart.module.scss`'s
  `.headerLabel` and `Row.module.scss`'s `.label`, so it reads as one continuous line down the
  whole column (both are `position: sticky; left: 0` at the same `LABEL_WIDTH`, stacked directly
  adjacent in normal flow with no gap between them).

**Verified live 2026-08-15** in a fresh single-member sandbox (24 dated checklists all under the
admin's own card membership, to force genuine scrolling without needing to grant board access to
other real accounts - deleted afterward, both board/project deletes confirmed 200): scrolled to
the bottom, measured a real 60px gap between the last row (`Admin item 24`) and the scroller's own
bottom edge; confirmed the divider line's computed style (`2px solid rgb(193, 199, 208)`); zero
console errors. The empty-member-hiding change itself is a small, mechanical refactor (same
`if (nothing) return early` shape already used one line above it for the card-level filter) that
was reasoned through carefully rather than separately live-tested with a genuinely-empty member -
doing that specific check would have meant granting board access to another real account, which
needs its own explicit go-ahead first.

### Round 5 follow-up: shading simplified to 2 tones (2026-08-15, same day)

Client asked why the chart showed what looked like 3 shades of grey. Real answer: `.bandShade`
(the alternating day/week/month band) and `.weekendShade` were two independent rgba overlays at
different opacity (`0.045`/`0.07`) that both painted unconditionally - a weekend day landing on an
already-shaded band compounded the two semi-transparent layers into a third, unintentional tone,
not a deliberate 3-tier design. Simplified to genuinely 2 tones (white or shaded): both selectors
now share one `rgba(9, 30, 66, 0.06)` value, and `GanttChart.jsx` computes a `bandedDayOffsets` Set
from whichever `bandSegments` is active and filters `weekendOffsets` against it before rendering,
so a day already covered by band shading never also gets a `weekendShade` div - the two are now
mutually exclusive per day, not just same-colored.

**Verified live 2026-08-15** in a minimal sandbox (one 16-day-spanning checklist, deleted
afterward): `getComputedStyle` on every `.bandShade`/`.weekendShade` element on the page returned
exactly one distinct color (`rgba(9, 30, 66, 0.06)`) across all 12 rendered shading divs - confirmed
programmatically, not just by eye, that no cell is ever double-shaded.

## Gantt round 6: bolder full-frame divider, day-grid shading protocol, Tasks/Team Workload cleanups, tab reorder (2026-08-15, same day)

Five more changes, same day as the round 5 follow-ups above:

- **Divider replaced with a single full-height element.** The per-row `border-right` (added in
  round 5) only ever reached as far down as the last real row - fine with lots of rows, but with
  only a few it stopped well short of the visible chart frame, and the client wanted it bolder
  besides. Removed the border from `Row.module.scss`'s `.label` entirely; `GanttChart.jsx` now
  renders one `.labelDivider` div (`3px`, `#8993a4`, matches the header's own now-bolder
  `.headerLabel` border) with `top: 0; bottom: 0` inside `.body`. For that to actually reach the
  frame's true bottom regardless of row count, `.body` itself needed an explicit min-height -
  there's no percentage-height CSS shortcut here (`.inner`'s own height is content-driven `auto`),
  so this reuses the same "ResizeObserver measures a ref, sets an explicit px style" pattern
  already established twice in this file (the width stretch-to-fill fix, `GanttView`'s own wrapper
  height fix): a second `ResizeObserver` watches the sticky header's own rendered height (which
  varies by scale - Day/Week show an extra day-number sub-row, Month doesn't) so `.body`'s
  min-height can be computed as exactly `frame height - header height`, not the whole frame on top
  of the header.
- **Shading redesigned to a fixed protocol, replacing the round-5 "2-tone alternating band + weekend"
  design entirely.** Client specified it directly: every calendar day gets a thin, faint separator
  line (`1px`, `rgba(9, 30, 66, 0.13)` - the same grid-line opacity already used by the header's own
  `.monthCell`/`.dayCell` borders) regardless of weekend/scale; weekends get a flat grey background
  (`rgba(9, 30, 66, 0.06)`); weekdays stay plain white. All the `dayShadeSegments`/
  `weekShadeSegments`/`monthShadeSegments`/`bandSegments`/`bandedDayOffsets` machinery from the
  last two rounds was removed outright rather than left dormant.
- **Tasks tab now hides cards with zero checklists** - previously an exhaustive audit of every
  card on the board (even completely bare ones); `Tasks.jsx` now filters to
  `item.taskLists.length > 0` before rendering, and `CardGroup`'s own now-always-true checklist
  block was simplified to unconditional rather than left as dead defensive code.
- **Team Workload bars were silently rendering with no text at all - a real bug, not a
  request for a new feature.** `Row.jsx`'s bar-label logic only ever checked
  `typeof label === 'string'`, which works for `Timeline.jsx` (plain string labels) but not
  `TeamWorkload.jsx`, whose rows use a richer JSX `label` (an icon + name span) for the left
  column. Fixed with a new, explicit `barLabel` string prop threaded separately from `label` -
  `TeamWorkload.jsx` now passes `barLabel: taskList.name`/`task.name` alongside its JSX `label`,
  and `Row.jsx` prefers `barLabel` when present, falling back to `label` itself when it's already
  a string (Timeline's existing behavior, unchanged). Also reused for the label column's hover
  `title` tooltip, which JSX labels never got before either.
- **Tabs reordered** to Timeline, Team Workload, Tasks, Schedule (was Timeline, Tasks, Team
  Workload, Schedule) - a one-line reorder of the `panes` array in `GanttView.jsx`.

Patch: `planka-custom/patches/0040-gantt-shading-status-colors-vzoom-scroll-fix-inline-toggle.patch`
(same patch file, amended in place through this whole day's rounds rather than as separate numbered
patches, since none of the earlier same-day cuts had shipped to a stable state yet).
**Verified live 2026-08-15** in a throwaway sandbox (one card with a single dated checklist, one
card with none, deleted afterward): divider width/color confirmed via `getComputedStyle`, and its
bottom edge measured exactly equal to the scroller's own bottom edge (`dividerBottom === 
scrollerBottom`) even with only one row on the board: day-grid-line and weekend-shade counts/colors
confirmed programmatically; Team Workload's bar rendered real visible text ("Only checklist") where
it previously rendered none; Tasks tab confirmed showing only the card with a checklist, not the
bare one; tab order confirmed via the rendered menu items; zero console errors across the full pass.

## Gantt divider genuinely single line, checklist task indentation (2026-08-15, deployed later same week)

Two small fixes that were built and committed ahead of time, held back at the client's explicit
request ("don't deploy, we'll batch it with more changes"), then deployed together once asked to
ship a new version:

- **Gantt label/chart divider fix** - the "bolder divider" from the round-6 entry above was
  actually two disconnected pieces (a border on the sticky header's own label cell, plus a
  separate `.body`-only div) with a real latent bug: the body-only div used plain
  `position: absolute`, so it scrolled away horizontally with the rest of the wide chart while the
  header's own sticky border stayed pinned - looked disconnected depending on scroll position.
  Replaced with `.labelDividerTrack` (plain absolute, `top`/`bottom: 0`, sized to `.inner`'s real
  full height for free) wrapping `.labelDivider` (the actual 3px line, `position: sticky` on the
  *left* axis only, pinned at the `LABEL_WIDTH` offset - same mechanism `.headerLabel`/`.label`
  already use pinned at `left: 0`). A `position: sticky` element can't be auto-sized by opposing
  `top`/`bottom` offsets the way absolute/fixed can, hence the two-element split.
- **Checklist task indentation** (`CardModal`'s Tasks/Checklists tab) - `Task.module.scss`'s
  `.wrapper` used `margin-left: -40px` specifically to cancel out the 40px indent its checklist
  ancestor (`CardModal/TaskLists/Item.jsx`'s `.moduleWrapper`) already applies, pulling every
  task's checkbox and name flush to the exact same x position as the checklist's own
  checkbox/title - looked like one flat list, no parent/child hierarchy. Reduced the negative
  margin to `-20px` (width bleed compensation matched, `calc(100% + 20px)`) so only the left edge
  moves, giving tasks a clear visual indent under their checklist. Confirmed via grep that
  `task-lists/TaskList/Task.jsx` is only ever imported by `CardModal/TaskLists/Item.jsx` - not the
  Kanban card face, not the Gantt view - so this couldn't affect anything else.

**Deployed and live-verified 2026-08-15**: divider's on-screen `left` position measured identical
before and after scrolling the chart horizontally 500px (`328` both times), confirming it's now
genuinely sticky and a single element; checklist task indentation confirmed visually on a real
card (`Task one` checkbox clearly offset right of `Checklist A`'s own checkbox) and via
`getBoundingClientRect()` on both checkboxes. Zero console errors, zero startup errors in the
container logs. Verified in a throwaway sandbox project, deleted afterward (board/project delete
both confirmed 200).


## Permissions audit: disguised 404, centralized project-manager-or-admin check (2026-08-17)

Client asked for a full review of the admin/permissions system ("so many layers... I need
administration frictionless"), then scoped the follow-up to concrete bugs/inconsistencies rather
than restructuring the model (confirmed via AskUserQuestion - the model itself is only 3 layers:
instance role admin/projectOwner/boardUser, per-project `ProjectManager` relation, per-board
`editor`/`viewer` membership - already reasonably centralized since patch 0010 introduced
`is-board-editor.js`).

Two real, verified issues found and fixed as patch 0042:

- **`board-memberships/create.js` disguised a permission failure as a 404.** This is the exact
  incident from the 2026-08-07 Taiga-import note above: `admin@planka.local` had genuine
  instance-admin status but wasn't a project manager on 2 of 3 projects, and got a plain `404
  "Board not found"` trying to add a member - indistinguishable from the board not existing. Fixed
  by disambiguating: if the caller has some real relationship to the board (admin role, or an
  existing `BoardMembership` row) but still isn't a project manager, throw `403 Not enough rights`
  instead of `404`. **This does not change who can create the membership** - only genuine project
  managers still can; the fix is purely about the error signal. True outsiders with zero
  relationship to the board still get `404`, preserving the intentional info-hiding.
- **`comments/delete.js` duplicated an inline admin-bypass check** (`isProjectManager ||
  (currentUser.role === ADMIN && !project.ownerProjectManagerId)`) that `is-board-editor.js`
  already centralizes for the equivalent board-level check. Centralized into a new helper,
  `server/api/helpers/users/is-project-manager-or-admin.js`, mirroring `is-board-editor.js`'s
  structure - and reused it for the `board-memberships/create.js` fix above. Pure refactor for
  `comments/delete.js`, confirmed behavior-identical.

A third suspected issue turned out to already be fixed: the share-picker's system-account filter
(`AddStep.jsx`) already does exact-email exclusion (`HIDDEN_SYSTEM_ACCOUNT_EMAILS`), not the
broader role-based filter that caused the earlier "real admins missing from the picker" bug -
verified directly in source, no change made.

**Explicitly not touched**, and why: the ~25 `isProjectManager`-only call sites that intentionally
lack an admin bypass (that's their real upstream contract, not a bug); the separate ~15-site
`role !== ADMIN || ownerProjectManagerId` "read access" gate (a different, already-consistent
mechanism - folding it into the new helper would risk silently changing read-vs-write semantics);
invite-service's independent `isBoardEditor` mirror (justified duplication - it has no PLANKA
session to call the real helper); the client's `getEffectiveMembershipModel()` (needed for
optimistic UI, not broken).

**Verified in an isolated throwaway stack** (fresh Postgres + the new image on isolated ports, not
production's DB - this deployment's established "regression harness" pattern for changes too
risky to verify only after deploying) before touching production. Learned along the way:
`POST /projects/:id/project-managers` requires the *target* user's instance role to already be
`admin` or `projectOwner` - a plain `boardUser` can never become a project manager, confirmed via
a live `422 "User must be admin or project owner"`. Also: `ownerProjectManagerId` (the "personal
project" marker the admin-bypass rule checks) is only set for `type: 'private'` projects, not
`type: 'shared'` ones, even though the creator is auto-added as a project manager either way.

All 4 board-membership scenarios and all 4 comment-delete scenarios matched expectations exactly:
admin-not-PM and board-editor-not-PM both now get `403` (was `404` for the admin case); a true
outsider still gets `404`; the genuine project manager still succeeds; and for comments, author,
genuine PM, and admin-bypass-on-a-shared-project all still delete successfully while an unrelated
user still gets denied (`403`, not `404` - unchanged pre-existing behavior, since that inner code
path wasn't touched by this refactor).

## Timeline tab: dated sub-tasks now shown (2026-08-17)

Client feedback: only checklist rows (`TaskList`) were visible in the Gantt Timeline tab -
individual dated sub-tasks (`Task`, nested under a checklist) never appeared, even though Team
Workload already showed them (filtered to the viewing member's own assignments). The data was
already there - `selectGanttItemsForCurrentBoard` (`selectors/gantt.js`) has always returned each
`taskList.tasks` pre-filtered to dated items - `Timeline.jsx` simply never iterated into it.

Fixed by mirroring Team Workload's existing pattern: for each dated checklist row, also push a row
per dated sub-task underneath it (unfiltered by assignee here, unlike Team Workload - Timeline is
grouped by card, not by member, so every dated sub-task belongs regardless of who it's assigned
to). Added the same icon + indentation visual language Team Workload already uses (`check square
outline` for checklists, `check circle outline` for sub-tasks, extra `padding-left` on the sub-task
label) so the two nesting levels read the same way in both tabs - previously Timeline used a plain
string label with no icon at all. A checklist now also counts as "dated" (and so gets shown) if it
has no dates of its own but contains at least one dated sub-task, matching Team Workload's identical
rule; a checklist and its sub-tasks with zero dates anywhere are still fully hidden, unchanged.

No changes needed to `Row.jsx`/`GanttChart.jsx` - `taskId`-driven bars and click-to-edit
(`EditDatesPopup`) were already fully wired end-to-end from Team Workload's earlier use of the same
mechanism.

**Verified live** in an isolated throwaway stack (fresh Postgres + the new image, not production -
this deployment's established pre-deploy regression-harness pattern) via Puppeteer: a sandbox card
with one checklist (itself dated) and 3 sub-tasks (2 dated - "Rough cut", "Color grade" - 1
undated - "Undated review task"). Timeline correctly rendered exactly 4 rows (card header,
checklist, both dated sub-tasks) with the undated sub-task absent, each sub-task bar positioned at
its own dates (not the parent checklist's), with the checkbox/circle icon distinction and deeper
indentation visible in the actual screenshot, not just inferred from code.

## Paste an image into the "Add card" title field (2026-08-18)

Client asked for the ability to paste a clipboard image directly into a new card's title field
while creating it, with the tool deciding what to name the resulting card. Confirmed this
deployment already has 2 precedents for clipboard-paste-to-attachment
(`CardModal/AddAttachmentZone/AddAttachmentZone.jsx`, `ProjectSettingsModal/BackgroundPane/
AddImageZone.jsx`) - this adds a third, scoped to `AddCard.jsx`'s own title `<TextArea>` instead of
a `window`-level listener, so it can never fire while unrelated to that specific composer (paste
events are focus-driven; the two existing listeners are unaffected, confirmed live below).

- **Naming decision**: if the title is still empty at paste time, it's auto-filled with `` `Pasted
  image – ${date}` `` (e.g. "Pasted image – Aug 18, 2026, 10:52 AM", `date-fns` `'PPp'` format,
  new i18n key `common.pastedImageCardName`). If the user already typed a title, pasting an image
  never overwrites it - confirmed live in both directions. A small preview chip (thumbnail +
  filename + remove "x") appears under the textarea so a mis-paste can be undone before submitting.
- **Card creation still one API call, attachment is a second, chained one** - PLANKA's
  `createCard` has no way to accept a file in the same request. `AddCard.jsx` carries the pasted
  `File` on `data.file` through `onCreate()` into whichever entry action the caller uses
  (`createCard`/`createCardInCurrentContext`/`createCardInCurrentList` all funnel into the same
  `createCard` saga generator in `sagas/core/services/cards.js`, confirmed by reading all 3 call
  sites - `List.jsx`, `FiniteContent.jsx` - so this needed exactly one saga-level change, not one
  per entry point). That saga now destructures `file` out of `data` before building the JSON
  API payload (a raw `File` must never ride along into `api.createCard`'s JSON body), then, once
  the real card id comes back, calls the existing `createAttachment(cardId, data)` generator from
  `sagas/core/services/attachments.js` directly (not the `createAttachmentInCurrentCard` wrapper,
  which depends on route-derived "current card" state that doesn't exist yet mid-creation) and sets
  the new attachment as the card's cover via the existing `updateCard(id, { coverAttachmentId })`
  already defined in the same file. `createAttachment` gained one additive `return attachment;`
  (it previously returned nothing) so the cover-set step has the new attachment's id to use.
- **Graceful degradation, not new error handling**: `createAttachment` already toasts and returns
  `undefined` on an upload/storage-limit failure (pre-existing behavior) - the card still gets
  created successfully with its title either way, the cover-set step is just skipped.

**Verified live** in an isolated throwaway stack (fresh Postgres + the new image, this deployment's
established pre-deploy regression-harness pattern), via a mix of the real API and Puppeteer
(synthetic `ClipboardEvent`+`DataTransfer` dispatched on the title textarea, since headless Chrome
has no real OS clipboard): empty-title paste produced the exact auto-generated title, a
custom-typed title survived a subsequent paste unchanged, and clicking the preview chip's remove
button before submitting correctly created a card with zero attachment. Confirmed via the real API
(not just the UI) that both non-removed cases got a real `file`-type attachment *and*
`coverAttachmentId` pointing at it. Regression-checked the existing `AddAttachmentZone` card-modal
paste zone with a fresh Puppeteer session (paste dispatched on `document.body` while a card modal
was open) - it still attached the file normally through its own unchanged code path, with zero
interference from the new `AddCard`-scoped listener. Zero console errors across the full pass.
Sandbox project deleted afterward; the whole throwaway stack (`docker-compose.test.yml`, tmpfs
Postgres) was then torn down with `down -v`, so no trace of any of this touched production.

Patch: `planka-custom/patches/0044-paste-image-into-add-card.patch`.

## Description/comment "Content exceeds 1MB" - real fix, not just the client cap (2026-08-18)

Client reported users/admins still couldn't paste media over 1MB - Save stayed disabled with
"Content exceeds 1MB" - even after the unrelated Aug 9 `MAX_UPLOAD_FILE_SIZE` fix (that one only
covers the card-modal's *file attachment* upload path, `server/api/helpers/utils/receive-file.js`,
a completely different code path from this bug).

**Root cause, found by reading the live code, not guessed**: pasting/dropping an image into a
card's Description or a Comment (both rendered via `MarkdownEditor.jsx`) never uploads it - the
`fileUploadHandler` there just does `FileReader.readAsDataURL(file)` and inlines the result as a
base64 data URI directly inside the markdown text. Base64 inflates size ~33% over the original
file. `EditMarkdown.jsx` then compares the *entire* markdown string length against a hardcoded
`MAX_LENGTH = 1048576` (1MB of characters) and disables Save if it's exceeded - so any screenshot
over roughly 750KB tripped it. This is why it's specifically "media over 1MB", not attachments.

**Two independent layers enforce the same number, both needed fixing** - initially raised only the
client `MAX_LENGTH`, verified via a direct card-update call through the UI (bypassing the client
gate isn't possible without it, so the *first* real end-to-end test - pasting a 2.2MB synthetic
file into a live card description via Puppeteer - is what caught this): the server rejected the
save anyway, `E_MISSING_OR_INVALID_PARAMS`, because `server/api/controllers/cards/{create,update}.js`
and `comments/{create,update}.js` *each* independently hard-code the identical
`maxLength: 1048576` on the `description`/`text` input validator - not a Waterline/DB default,
each controller sets it explicitly in its own `inputs` block. Missing this on the first pass would
have shipped a fix that still failed silently server-side while showing a fully-enabled Save button
- worth remembering for any future "just bump the client-side limit" fix in this app: check for a
matching hard-coded validator in the corresponding controller(s) before assuming the client check
is the only gate.

**Fix**: raised all 5 occurrences (1 client `MAX_LENGTH` + 4 server `maxLength` validators across
the two card controllers and two comment controllers) from `1048576` to `15728640` (15MB of text),
in lockstep. Chose 15MB specifically because nothing else caps out below it -
confirmed via the actual running container: `sails-hook-sockets`' own default
`maxHttpBufferSize` is 100MB (`10E7`, overriding `engine.io`'s much smaller 1MB library default,
which had no effect here), and `card.description`/`comment.text` are unbounded Postgres `text`
columns. 15MB of base64 text comfortably fits real-world screenshots/photos (~11MB of original
binary) without raising the per-card payload size enough to meaningfully bloat every board-load
fetch - this stays a *text* cap, not a real upload path, so it's deliberately not matched to the
50MB attachment-file limit from the Aug 9 fix.

**Verified live** in the same isolated throwaway stack/pattern as the paste-into-title feature
above: created a project/board/list/card through the real UI, opened the card's description
editor, dispatched a synthetic paste of a 2.2MB file (same `ClipboardEvent`+`DataTransfer`
technique as the AddCard feature, targeted at the editor's `[contenteditable]` node this time),
confirmed the Save button stayed enabled (previously would've shown "Content exceeds 1MB" and been
disabled), clicked Save, and - the part that actually proves the server-side fix, not just the
client one - reloaded the page and confirmed the image reference was still present in the
persisted description with zero console errors. Before the server-side controller fix was added,
this exact same reload check failed (image gone, `E_MISSING_OR_INVALID_PARAMS` in the console) even
though the client-side Save button had already been "fixed" - the live end-to-end check is what
caught that the fix was incomplete.

Patch: `planka-custom/patches/0045-raise-description-content-limit.patch`.

## Submissions tab silently dropping every fetched comment (2026-08-19)

Admin reported: comments posted in the Submissions tab "disappear after a few hours" - Updates
tab unaffected. Confirmed first via direct Postgres query that **no data was actually being
lost** - `comment` rows with `type='submission'` were all still present, going back to
2026-08-13, so this was never a deletion/TTL issue despite how it read from the report.

**Root cause, found by reading the code the Submissions tab (patch 0034) added, not guessed**:
`client/src/models/Comment.js` and `client/src/models/User.js` are redux-orm models whose static
`reducer()` upserts fetched records into the client-side store on `ActionTypes.
COMMENTS_FETCH__SUCCESS`. Patch 0034 added a parallel `SUBMISSIONS_FETCH__SUCCESS` action for the
new tab and correctly wired it into `Card.js` (to track `isSubmissionsFetching`/
`isAllSubmissionsFetched`/`lastSubmissionId`) - but never added a matching case to `Comment.js`
or `User.js`. So every submissions fetch **succeeded on the wire** (confirmed live via a raw
WebSocket-frame capture: the server returned the real, correct rows, `type: "submission"` and
all) but the returned comment/user records were silently thrown away instead of being written
into the redux-orm store - the tab rendered blank regardless of how much real data existed.

This reproduced on **any** fresh fetch, not literally after a fixed time period - a submission
posted just now stays visible immediately because the separate `COMMENT_CREATE`/
`COMMENT_CREATE__SUCCESS` cases (unaffected by this bug) already upsert it directly. It only goes
blank on the *next* fetch - reopening the card, reloading the page, or (most likely culprit for
"a few hours" specifically) a `SOCKET_RECONNECT_HANDLE` action, which wipes `Comment.all()` and
`Card`'s per-card tracking fields back to their unfetched defaults and relies on a fresh fetch to
repopulate them. Socket reconnects happen naturally over a multi-hour session (proxy idle
timeouts, laptop sleep/wake, wifi drops) - explaining why the symptom reads as delayed onset.

**Fix**: added `case ActionTypes.SUBMISSIONS_FETCH__SUCCESS:` alongside the existing
`COMMENTS_FETCH__SUCCESS` case in both `Comment.js` (upserts each fetched comment) and `User.js`
(upserts each fetched comment's author into the shared user store). Two-line change, no new
concepts - makes the Submissions pattern symmetric with Comments and Activities' own already-
correct handling of `ACTIVITIES_IN_{BOARD,CARD}_FETCH__SUCCESS`, confirmed by grepping every
`*_FETCH__SUCCESS` action type against every model file's reducer before considering this closed.

**Verified live** two ways: (1) end-to-end in the isolated throwaway stack (this deployment's
established pre-deploy regression pattern) - created a project/board/list/card, posted a real
submission, confirmed it rendered immediately, then did a **full page reload** (the actual
regression check - this is exactly the fetch path that was broken) and confirmed the submission
was still there; (2) against real production data, both before and after deploying - two live
cards with genuine multi-day-old submissions (dates back to 2026-08-14 and 2026-08-16) that
rendered completely blank pre-fix now show every entry correctly, with zero rows lost or altered
in Postgres throughout (`comment` row counts unchanged before/after: 452 update / 33 submission).

Patch: `planka-custom/patches/0046-fix-submissions-tab-not-persisting.patch`.

## Split card-face comment badge into separate Updates/Submissions counters (2026-08-19)

Follow-up to the Submissions-tab fix above. Once that fix made Submissions actually render, the
client noticed the Kanban card-face badge combines Updates and Submissions into one number/icon -
asked for two separate icons instead.

Confirmed `card.commentsTotal` (`comments_total` column) was never type-aware:
`server/api/hooks/query-methods/models/Comment.js`'s `createOne`/`deleteOne`/`delete_` increment
and decrement it unconditionally regardless of `comment.type`, a leftover from before the
Submissions tab (patch 0034) added a `type` column to `Comment` at all - confirmed live against
Postgres before touching anything (`comments_total` on real cards exactly equalled update+
submission combined, not either alone).

**Fix**: added a second counter, `submissions_total` (new migration
`20260819160000_add_submissions_total_to_card.js`), and made `comments_total` update-only-scoped
going forward - it keeps its existing column/attribute name since that's literally what "Comment"
already meant before Submissions existed as a separate concept, no need to rename it. Both
`createOne`/`deleteOne` in the query-methods hook now pick which column to touch based on
`comment.type`; the bulk `delete_` (multi-comment cascade delete, e.g. when a card is deleted)
now tallies each affected card's removed comments per-type and updates both columns in one query
instead of one combined total. The migration also backfills both counters for every existing card
from real `comment` rows (`COUNT(*) FILTER (WHERE type = ...)` grouped by `card_id`), not just
cards touched going forward - verified post-deploy that `comments_total`/`submissions_total`
summed across all 253 real cards match the real per-type `comment` table counts exactly (454/33).

Client mirrors this exactly: `Card.js` gained a `submissionsTotal` field, and every place that
optimistically bumped `commentsTotal` (`COMMENT_CREATE`/`COMMENT_CREATE_HANDLE`/
`COMMENT_DELETE_HANDLE` in `Card.js`, `COMMENT_CREATE__FAILURE`/`COMMENT_DELETE` in `Comment.js`)
now branches on the comment's `type` first. `Card/ProjectContent.jsx` and `Card/StoryContent.jsx`
(the two Kanban card-face renderers) each gained a second badge - existing `comment outline` icon
stays for Updates, new `upload` icon (chosen to read as "submitted a deliverable", distinct from
the existing `attach` icon already used for file attachments) for Submissions, both gated on
their own `> 0` check independently so a card with only one type shows only one badge.

**Verified live** in the isolated throwaway stack: posted 2 Updates + 1 Submission on a sandbox
card, confirmed both badges render with the correct independent counts (`💬 2`, `⬆ 1`) and survive
a full page reload (proving the counters are real server state, not just optimistic client math).
Deployed to production and re-verified against the two real cards used in the Submissions-tab fix
above - `comments_total`/`submissions_total` exactly match their real comment counts (2/4 and
8/10), and a full-database sum check confirmed zero drift across all 253 cards.

Patch: `planka-custom/patches/0047-split-updates-submissions-counters.patch`.

## Pasted Google Docs/Drive links showing "Sorry, the file you have requested does not exist" (2026-08-21)

Client asked whether Planka was responsible for many pasted Google Docs/Drive links breaking with
Google's own "file does not exist" error, and requested a "deep check" of the Updates/Submissions
comment system. Audited the whole path first (composer `Add.jsx`/`Edit.jsx`, `react-mentions`'
paste handler, `mentionTextToMarkup`, the `comment.text` column/validation, `Markdown.jsx` +
`@diplodoc/transform`) - none of it transforms or truncates text; a battery of clean, realistic
Google URLs (underscores, `resourcekey=`, `authuser=`, fragments, mid-sentence, parens) all
rendered byte-perfect. Planka wasn't inserting anything.

Querying real `comment` rows directly turned up the actual cause: 190 stored comments (all type
`update`, 0 `submission` - Submissions links are pasted fresh from Drive's own share dialog,
Updates are where staff paste pre-formatted task lists) already contained a literal `\` character
inside the URL itself (e.g. `...ZR1\_KgZYfbSuFI3\_G80`), confirmed via a raw byte/hex dump of one
row. That's a Markdown-escape artifact - the kind AI chat tools and HTML-to-Markdown converters
add before underscores - baked into the *stored* text before it ever reached Planka; several
affected rows are literally tagged `[originally posted by ... on ...]`, i.e. from an email-import
path that converts HTML to Markdown.

Planka wasn't blameless once that corrupted text arrived, though: `configs/markdown-plugins/
link.js`'s `process()` never got a chance to fix (or even see) it for *bare* pasted URLs, because
the plugin was registered `md.core.ruler.before('includes', 'link', plugin)` - which runs before
markdown-it's own `linkify` core rule creates `link_open` tokens for bare URLs at all. It only
ever touched explicit `[text](url)` syntax (whose destination CommonMark already backslash-
unescapes during parsing, so those hrefs were already clean). And once `process()` *does* see a
linkify-created token, `token.attrGet('href')` no longer contains a raw `\` - markdown-it's own
link normalization has already percent-encoded it to `%5C` by that point, so a naive
`href.includes('\\')` check would still miss it.

**Fix** (`link.js`): (1) registration changed to unconditional `md.core.ruler.push('link',
plugin)`, so it always runs last, after `linkify`/`replacements`/`smartquotes`/`text_join`; (2)
`process()` now detects `%5c` (case-insensitive) in the resolved href, strips it, and re-syncs the
adjacent label text token too. Backslash is never a valid literal character in a real URL, so
stripping it is always safe/correct, never a guess. Verified against the exact real corrupted
sample from prod (`.../1SISopaRpkykKRpWoX\_HD91jBnd4OtSc5/...`) - resolves to the correct 33-char
Drive file id, confirmed in the isolated stack via a posted comment whose rendered `<a>` had the
clean href and label, surviving reload.

**Data cleanup**: separate one-off script (`docker run --network planka_default` + `pg`, DB
credentials read from `.env` via `--env-file`, never on the command line) found every comment
containing a `\`, and for each one stripped backslashes *only* from within `https?://[^\s)\]]+`
spans - leaving unrelated escaped punctuation elsewhere in the same comment (e.g. `1\. Item`)
untouched. Backed up all 190 original rows to `backups/comment-backslash-cleanup-2026-08-21.json`
before writing, applied inside a single transaction, then re-ran the detection query against
production: 0 comments with a broken href remain, and the `docs.google.com` file-id length
distribution across the whole table collapsed from a wide, telltale spread (1-42 chars) down to
just the two genuinely valid Google id lengths (33 and 44).

Patch: `planka-custom/patches/0048-fix-backslash-escaped-links.patch`.
