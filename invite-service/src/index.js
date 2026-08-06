const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const { OPS_DB_NAME, ensureOpsDatabaseExists, ensureSchema } = require('./db');
const planka = require('./planka');
const { sendInviteEmail } = require('./mailer');
const { ensureCsrfToken, verifyCsrfToken } = require('./csrf');
const {
  loginPage,
  invitePage,
  joinPage,
  assignPage,
  acceptPage,
  acceptSuccessPage,
  messagePage,
} = require('./templates');

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
    session({
      store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 2 * 60 * 60 * 1000 },
    }),
  );

  function requireAdmin(req, res, next) {
    if (!req.session.adminToken || req.session.adminRole !== 'admin') {
      return res.redirect(`${BASE_PATH}/login`);
    }
    return next();
  }

  // --- Admin auth ---

  app.get('/login', (req, res) => {
    res.send(loginPage({ error: req.query.error, csrfToken: ensureCsrfToken(req) }));
  });

  app.post('/login', async (req, res) => {
    if (!verifyCsrfToken(req, req.body._csrf)) {
      return res.status(403).send(messagePage('Expired form', 'Please go back and try again.'));
    }

    const { emailOrUsername, password } = req.body;
    try {
      const token = await planka.login(emailOrUsername, password);
      const me = await planka.getMe(token);

      if (me.role !== 'admin') {
        return res.redirect(
          `${BASE_PATH}/login?error=${encodeURIComponent('Only PLANKA admins can send invites.')}`,
        );
      }

      req.session.adminToken = token;
      req.session.adminRole = me.role;
      req.session.adminEmail = me.email;
      // Trailing slash matters: Caddy's `handle_path /invite/*` only
      // matches with it; `/invite` alone falls through to PLANKA's own
      // catch-all SPA route instead (see BASE_PATH comment above).
      return res.redirect(`${BASE_PATH}/`);
    } catch (error) {
      return res.redirect(`${BASE_PATH}/login?error=${encodeURIComponent(error.message)}`);
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect(`${BASE_PATH}/login`));
  });

  // --- Invite creation (admin only) ---

  app.get('/', requireAdmin, async (req, res) => {
    try {
      const boards = await planka.listBoards(req.session.adminToken);
      res.send(
        invitePage({
          boards,
          csrfToken: ensureCsrfToken(req),
          adminEmail: req.session.adminEmail,
          error: req.query.error,
          success: req.query.success,
          joinUrl: `${PUBLIC_URL}${BASE_PATH}/join`,
        }),
      );
    } catch (error) {
      res.status(500).send(messagePage('Error', `Could not load boards: ${error.message}`));
    }
  });

  // --- Self-signup (public, no gate by design - see CLAUDE.md) ---

  app.get('/join', (req, res) => {
    res.send(joinPage({ error: req.query.error, csrfToken: ensureCsrfToken(req) }));
  });

  app.post('/join', async (req, res) => {
    if (!verifyCsrfToken(req, req.body._csrf)) {
      return res.status(403).send(messagePage('Expired form', 'Please go back and try again.'));
    }

    const { name, email, password, passwordConfirm } = req.body;
    const redirectWithError = (msg) =>
      res.redirect(`${BASE_PATH}/join?error=${encodeURIComponent(msg)}`);

    if (!name || !email || !password) return redirectWithError('All fields are required.');
    if (password.length < 8) return redirectWithError('Password must be at least 8 characters.');
    if (password !== passwordConfirm) return redirectWithError('Passwords do not match.');

    try {
      // Same rationale as the invite-accept flow: the visitor has no PLANKA
      // session, so account creation goes through the dedicated service
      // account rather than requiring an admin to be present.
      const serviceToken = await planka.login(
        process.env.PLANKA_SERVICE_EMAIL,
        process.env.PLANKA_SERVICE_PASSWORD,
      );
      await planka.createUser({ email, password, name }, serviceToken);
      res.send(acceptSuccessPage(PLANKA_PUBLIC_URL));
    } catch (err) {
      redirectWithError(`Could not create your account: ${err.message}`);
    }
  });

  // --- Batch-assign users to boards (admin only) ---

  app.get('/assign', requireAdmin, async (req, res) => {
    try {
      const [users, boards] = await Promise.all([
        planka.listUsers(req.session.adminToken),
        planka.listBoards(req.session.adminToken),
      ]);
      res.send(
        assignPage({
          users,
          boards,
          csrfToken: ensureCsrfToken(req),
          adminEmail: req.session.adminEmail,
          error: req.query.error,
          success: req.query.success,
        }),
      );
    } catch (error) {
      res.status(500).send(messagePage('Error', `Could not load users/boards: ${error.message}`));
    }
  });

  app.post('/assign', requireAdmin, async (req, res) => {
    if (!verifyCsrfToken(req, req.body._csrf)) {
      return res.status(403).send(messagePage('Expired form', 'Please go back and try again.'));
    }

    const { boardRole } = req.body;
    const userIds = [].concat(req.body.userIds || []);
    const boardIds = [].concat(req.body.boardIds || []);

    if (userIds.length === 0 || boardIds.length === 0 || !['editor', 'viewer'].includes(boardRole)) {
      return res.redirect(
        `${BASE_PATH}/assign?error=${encodeURIComponent('Select at least one user and one board.')}`,
      );
    }

    let added = 0;
    let skipped = 0;
    for (const userId of userIds) {
      for (const boardId of boardIds) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await planka.createBoardMembership(boardId, userId, boardRole, req.session.adminToken);
          added += 1;
        } catch (err) {
          // Most common cause: already a member of that board (409 conflict)
          // - not worth aborting the whole batch over.
          skipped += 1;
        }
      }
    }

    return res.redirect(
      `${BASE_PATH}/assign?success=${encodeURIComponent(
        `Added ${added} membership(s)${skipped ? `, skipped ${skipped} (already a member or error)` : ''}.`,
      )}`,
    );
  });

  app.post('/send', requireAdmin, async (req, res) => {
    if (!verifyCsrfToken(req, req.body._csrf)) {
      return res.status(403).send(messagePage('Expired form', 'Please go back and try again.'));
    }

    const { email, boardId, boardRole } = req.body;

    if (!email || !boardId || !['editor', 'viewer'].includes(boardRole)) {
      return res.redirect(`${BASE_PATH}/?error=${encodeURIComponent('All fields are required.')}`);
    }

    try {
      const boards = await planka.listBoards(req.session.adminToken);
      const board = boards.find((b) => b.id === boardId);
      if (!board) {
        return res.redirect(
          `${BASE_PATH}/?error=${encodeURIComponent('That board no longer exists.')}`,
        );
      }

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      await pool.query(
        `INSERT INTO invites (token_hash, email, board_id, board_name, board_role, invited_by_email, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tokenHash, email, board.id, board.name, boardRole, req.session.adminEmail, expiresAt],
      );

      const acceptUrl = `${PUBLIC_URL}${BASE_PATH}/accept/${rawToken}`;
      await sendInviteEmail({
        to: email,
        boardName: board.name,
        inviterEmail: req.session.adminEmail,
        acceptUrl,
        expiresAt,
      });

      return res.redirect(
        `${BASE_PATH}/?success=${encodeURIComponent(`Invite sent to ${email}.`)}`,
      );
    } catch (error) {
      return res.redirect(
        `${BASE_PATH}/?error=${encodeURIComponent(`Could not send invite: ${error.message}`)}`,
      );
    }
  });

  // --- Accept flow (public, token-gated) ---

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
      redirectWithError(`Could not create your account: ${err.message}`);
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
