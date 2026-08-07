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
machinery built for it is what Phase 2 (Trello) will reuse.

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
- **Pre-existing UX gap surfaced and fixed while building this**: PLANKA's password field uses
  `zxcvbn(value).score >= 2`, not just a length check — a password like `password1234` passes the
  8-char `minlength` on the form but gets rejected by the API with a generic "missing or invalid
  parameter" message that doesn't explain why. This affects the original invite-accept flow too,
  not just the new join page. Fixed by adding a hint under the password field on both `/join` and
  `/accept/:token`: *"Must be reasonably strong — a common word plus a few digits ... will be
  rejected."* Not fixed: the server-side error message itself is still PLANKA's generic one if a
  weak password slips through — acceptable, since the hint should prevent most cases and a
  clearer message would require guessing at PLANKA's internal validation from the outside.
- Verified end-to-end on 2026-08-06 against the live site: self-signup created a real account via
  `/invite/join`, batch-assign added that account to a temporary test board via `/invite/assign`
  (confirmed via `GET /api/boards/:id` showing the new `boardMemberships` row), then all test
  artifacts (project, board, test user) were deleted — instance back to 0 projects / 3 real
  accounts (bootstrap admin, invite-service, `admin@bsymedia.com`) as of last check.

## Backups (Phase 1, 2026-08-05)

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

## In-app "Invite users" button (Phase 1, 2026-08-05)

Admins asked for a way to reach the invite tool without remembering/typing `/invite/` by hand.
PLANKA has **no native customization hook** for this — confirmed against live source
(`config/custom.js`, `api/`) that there's no custom-menu/custom-link/custom-HTML setting to hook
into. Patching the compiled React bundle (`/app/public/assets/*.js`, hashed/minified filenames
that change every version) to add a real nav-bar item would be fragile reverse-engineering, so
instead: `planka-custom/` is a thin wrapper `Dockerfile` (`FROM
ghcr.io/plankanban/planka:2.1.1`, the same pinned tag as before) that patches only
`/app/views/index.ejs` — the small server-rendered HTML shell, not the JS bundle — inserting a
floating "Invite users" link (`planka-custom/invite-button.html`) that opens `/invite/` in a new
tab. `docker-compose.yml`'s `planka` service now builds this instead of pulling the image
directly (`build: ./planka-custom` in place of `image: ghcr.io/...`) — version pin is preserved,
just one layer removed; bumping PLANKA's version means bumping the `FROM` line here too.

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
