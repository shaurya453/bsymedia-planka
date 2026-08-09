const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const zxcvbn = require('zxcvbn');
const validator = require('validator');

const { OPS_DB_NAME, ensureOpsDatabaseExists, ensureSchema } = require('./db');
const planka = require('./planka');
const { sendInviteEmail } = require('./mailer');
const { ensureCsrfToken, verifyCsrfToken } = require('./csrf');
const { acceptPage, acceptSuccessPage, messagePage } = require('./templates');

// A user reported "Could not create your account: ...due to 1 missing or
// invalid parameter" on 2026-08-09 - PLANKA's raw Sails validation error,
// passed straight through by this service, naming no field and suggesting
// no fix. Root cause NOT fully confirmed (no logged copy of their actual
// submitted values survived - lost when this service's container was later
// recreated to deploy this very fix) - reproduced by matching the exact
// error text against two independently plausible causes, both closed here
// rather than picking one:
//   1. Password strength: PLANKA rejects passwords with
//      `zxcvbn(value).score >= 2` (utils/validators.js's `isPassword`
//      custom validator), not just a length check - "password1234" clears
//      an 8-char minimum but scores 1. Reproduced this exact error text
//      directly against the live API with that password.
//   2. Email format: the signup form's email field (PLANKA client,
//      2026-08-06 patch) is a plain text input with no `type="email"` and
//      no client-side format check, and this service only checked
//      `!email` (truthy) before 2026-08-09 - any non-empty malformed string
//      reached PLANKA's `isEmail: true` validator and would produce the
//      identical generic message.
// Both are now checked here, mirroring PLANKA's own server-side rules
// exactly (same zxcvbn version pinned in package.json to avoid scoring
// drift; same `validator` package PLANKA itself uses for isEmail) - either
// one is caught with a specific, actionable reason before ever reaching
// PLANKA's API, instead of an approximation that can still slip through.
const PASSWORD_TOO_WEAK_MESSAGE =
  "That password is too weak. Common patterns like a word plus a few digits (e.g. \"password1234\") get rejected even though they're 8+ characters - try adding an unrelated word or a few random characters instead.";

const INVALID_EMAIL_MESSAGE = "That doesn't look like a valid email address - double-check it.";

function isPasswordStrongEnough(password) {
  return zxcvbn(password).score >= 2;
}

function isValidEmail(email) {
  return validator.isEmail(email);
}

// Defense in depth for any OTHER validation rule PLANKA's API enforces that
// isn't explicitly pre-checked above (e.g. a future PLANKA change) - never
// surface its raw Sails framework text (which names no specific field and
// suggests no fix) to an end user again.
function friendlyAccountCreationError(error) {
  if (/missing or invalid parameter/i.test(error.message)) {
    return 'Something about those details was rejected by the server. Double-check your password is strong (not just long) and your email is valid, then try again - if it keeps happening, contact an admin.';
  }

  return error.message;
}

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://bsymedia.duckdns.org
const PLANKA_PUBLIC_URL = process.env.PLANKA_PUBLIC_URL || PUBLIC_URL;
const INVITE_EXPIRY_DAYS = 7;

// Caddy mounts this service at /invite/* and strips that prefix before
// proxying, so Express's own view of its routes has no prefix - but
// browser-facing redirects need it added back, or they'd resolve against
// the public host root (which is PLANKA itself, not us).
const BASE_PATH = '/invite';

if (!PUBLIC_URL) {
  throw new Error('PUBLIC_URL env var is required (e.g. https://bsymedia.duckdns.org)');
}
if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET env var is required');
}
if (!process.env.OPS_DATABASE_URL) {
  throw new Error('OPS_DATABASE_URL env var is required');
}

async function main() {
  // OPS_DATABASE_URL points at the `postgres` maintenance DB the first time
  // this runs, since `planka_ops` may not exist yet - ensure it, then open
  // the real pool against planka_ops itself.
  await ensureOpsDatabaseExists(process.env.OPS_DATABASE_URL);

  const opsDbUrl = process.env.OPS_DATABASE_URL.replace(/\/[^/]*$/, `/${OPS_DB_NAME}`);
  const pool = new Pool({ connectionString: opsDbUrl });
  await ensureSchema(pool);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  app.use(
    // BSY Media: kept only for /accept/:token's CSRF token storage below -
    // the admin-login-gated HTML pages that used to need this (send,
    // join, assign) have all been superseded by PLANKA's own React UI
    // (Share modal's invite-by-email, the login page's sign-up toggle) and
    // removed. See CLAUDE.md for the full before/after.
    session({
      store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 2 * 60 * 60 * 1000 },
    }),
  );

  // Shared by the JSON /api/send route below - generates the token, stores
  // the invite row, and emails the link. Board lookup/resolution and
  // authorization are the caller's own job.
  async function createAndSendInvite({ email, board, boardRole, inviterEmail }) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO invites (token_hash, email, board_id, board_name, board_role, invited_by_email, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tokenHash, email, board.id, board.name, boardRole, inviterEmail, expiresAt],
    );

    const acceptUrl = `${PUBLIC_URL}${BASE_PATH}/accept/${rawToken}`;
    await sendInviteEmail({
      to: email,
      boardName: board.name,
      inviterEmail,
      acceptUrl,
      expiresAt,
    });
  }

  // --- JSON invite API (Bearer-token auth via the caller's own PLANKA
  // access token, read directly by the PLANKA React client's Share modal -
  // no invite-service login of any kind needed) ---

  app.post('/api/send', express.json(), async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token.' });
    }

    const { email, boardId, boardRole } = req.body || {};

    if (!email || !boardId || !['editor', 'viewer'].includes(boardRole)) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    let me;
    try {
      me = await planka.getMe(token);
    } catch (error) {
      // A user reported this exact "log into PLANKA again" message
      // persisting even after a real re-login - root-caused by reading the
      // code: this branch fired for ANY failure verifying the token
      // (network error reaching PLANKA, PLANKA returning a 500, etc.), not
      // just an actually-expired one, and blamed the session regardless -
      // which would never be fixed by logging in again if the real cause
      // was something else. Now only blames the session when PLANKA
      // itself actually said 401; anything else gets a message that
      // doesn't send the user chasing the wrong fix, plus a server-side
      // log line so the real cause is captured next time instead of lost.
      if (error instanceof planka.PlankaApiError && error.status === 401) {
        return res
          .status(401)
          .json({ error: 'Invalid or expired session - log into PLANKA again.' });
      }

      console.error('POST /api/send: could not verify session:', error);
      return res.status(502).json({
        error:
          'Could not reach PLANKA to verify your session - this looks like a temporary server issue, not a problem with your login. Try again in a moment; contact an admin if it keeps happening.',
      });
    }

    try {
      const authContext = await planka.getBoardAuthContext(boardId, token);

      if (!authContext) {
        return res.status(404).json({ error: 'That board no longer exists.' });
      }

      const { board, project, projectManagers } = authContext;

      // Mirrors PLANKA's own board-memberships/create.js gate (project
      // manager required) plus the admin-bypass-except-personal-projects
      // rule already established elsewhere in this deployment - kept
      // consistent rather than inventing a third authorization rule.
      const isManager = projectManagers.some(
        (pm) => pm.userId === me.id && pm.projectId === project.id,
      );
      const isAdminBypass = me.role === 'admin' && !project.ownerProjectManagerId;

      if (!isManager && !isAdminBypass) {
        return res.status(403).json({ error: 'Not enough rights.' });
      }

      await createAndSendInvite({ email, board, boardRole, inviterEmail: me.email });

      return res.json({ success: true });
    } catch (error) {
      console.error('POST /api/send: could not complete invite:', error);
      return res.status(500).json({ error: `Could not send invite: ${error.message}` });
    }
  });

  // --- JSON self-signup API (public, no auth by design - same trade-off
  // as the old /invite/join page it replaces: no passphrase/domain gate,
  // deliberate choice for an internal tool, see CLAUDE.md. Now reachable
  // directly from PLANKA's own login page via the "New user? Sign up"
  // toggle instead of a separate webpage) ---

  app.post('/api/join', express.json(), async (req, res) => {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: INVALID_EMAIL_MESSAGE });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    if (!isPasswordStrongEnough(password)) {
      return res.status(400).json({ error: PASSWORD_TOO_WEAK_MESSAGE });
    }

    try {
      // Same rationale as the invite-accept flow below: the visitor has no
      // PLANKA session, so account creation goes through the dedicated
      // service account rather than requiring an admin to be present.
      const serviceToken = await planka.login(
        process.env.PLANKA_SERVICE_EMAIL,
        process.env.PLANKA_SERVICE_PASSWORD,
      );
      await planka.createUser({ email, password, name }, serviceToken);

      return res.json({ success: true });
    } catch (error) {
      return res
        .status(500)
        .json({ error: `Could not create your account: ${friendlyAccountCreationError(error)}` });
    }
  });

  // --- Accept flow (public, token-gated - still the landing page for
  // every emailed invite link, old and new) ---

  async function getValidInvite(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query('SELECT * FROM invites WHERE token_hash = $1', [tokenHash]);
    const invite = rows[0];

    if (!invite) return { error: 'This invite link is invalid.' };
    if (invite.used_at) return { error: 'This invite has already been used.' };
    if (new Date(invite.expires_at) < new Date()) return { error: 'This invite has expired.' };

    return { invite };
  }

  app.get('/accept/:token', async (req, res) => {
    const { invite, error } = await getValidInvite(req.params.token);
    if (error) return res.status(400).send(messagePage('Invite not valid', error));

    res.send(
      acceptPage({
        email: invite.email,
        boardName: invite.board_name,
        boardRole: invite.board_role,
        csrfToken: ensureCsrfToken(req),
        token: req.params.token,
        error: req.query.error,
      }),
    );
  });

  app.post('/accept/:token', async (req, res) => {
    if (!verifyCsrfToken(req, req.body._csrf)) {
      return res.status(403).send(messagePage('Expired form', 'Please go back and try again.'));
    }

    const { invite, error } = await getValidInvite(req.params.token);
    if (error) return res.status(400).send(messagePage('Invite not valid', error));

    const { name, password, passwordConfirm } = req.body;
    const redirectWithError = (msg) =>
      res.redirect(`${BASE_PATH}/accept/${req.params.token}?error=${encodeURIComponent(msg)}`);

    if (!name || !password) return redirectWithError('Name and password are required.');
    if (password.length < 8) return redirectWithError('Password must be at least 8 characters.');
    if (!isPasswordStrongEnough(password)) return redirectWithError(PASSWORD_TOO_WEAK_MESSAGE);
    if (password !== passwordConfirm) return redirectWithError('Passwords do not match.');

    try {
      // Invite acceptance is unauthenticated by design (that's the point of
      // the emailed link) - the person accepting has no PLANKA session. We
      // need an admin-privileged token to create their account, so we use a
      // dedicated service account rather than depending on the original
      // inviter's session still being alive.
      const serviceToken = await planka.login(
        process.env.PLANKA_SERVICE_EMAIL,
        process.env.PLANKA_SERVICE_PASSWORD,
      );

      const created = await planka.createUser(
        { email: invite.email, password, name },
        serviceToken,
      );
      await planka.createBoardMembership(
        invite.board_id,
        created.item.id,
        invite.board_role,
        serviceToken,
      );

      await pool.query('UPDATE invites SET used_at = now() WHERE id = $1', [invite.id]);

      res.send(acceptSuccessPage(PLANKA_PUBLIC_URL));
    } catch (err) {
      redirectWithError(`Could not create your account: ${friendlyAccountCreationError(err)}`);
    }
  });

  app.listen(PORT, () => {
    console.log(`invite-service listening on :${PORT}`);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
