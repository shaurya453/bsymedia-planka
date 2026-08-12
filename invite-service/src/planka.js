const PLANKA_URL = process.env.PLANKA_INTERNAL_URL || 'http://planka:1337';

class PlankaApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// BSY Media: PLANKA's own client always logs in with `withHttpOnlyToken=true`
// (client/src/api/access-tokens.js), which makes the server bind that
// session to a second, httpOnly `httpOnlyToken` cookie
// (server/api/hooks/current-user/index.js: `if (session.httpOnlyToken &&
// httpOnlyToken !== session.httpOnlyToken) return null`) - the bearer JWT
// alone is then NOT enough to authenticate as that user; the matching
// cookie value has to ride along too. Found the hard way: a real
// browser-logged-in admin's token, forwarded here as a bearer header with
// no cookie, was silently rejected by PLANKA (401, generic "access token
// invalid" - looks exactly like a bad/expired token, not a missing-cookie
// one) even though the identical token worked fine for every call PLANKA's
// own React client made in the same browser tab. A token minted directly
// via a raw `POST /api/access-tokens` (no `withHttpOnlyToken`) has no such
// cookie requirement, which is why that always "worked" in manual testing
// and masked the gap. httpOnlyToken's cookie path is
// `sails.config.custom.baseUrlPath || '/'`, i.e. the whole domain for this
// single-app deployment, so it does reach invite-service's own routes too
// (same site, `SameSite=Strict` doesn't block a same-origin fetch) -
// callers just need to read it off the *inbound* request and hand it back
// here to forward on the *outbound* one.
async function request(path, { method = 'GET', token, httpOnlyToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (httpOnlyToken) headers.Cookie = `httpOnlyToken=${httpOnlyToken}`;

  const res = await fetch(`${PLANKA_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new PlankaApiError(data.message || `PLANKA API error (${res.status})`, res.status, data);
  }

  return data;
}

// Returns an access token, or throws. Callers should give the user a clear
// message rather than PLANKA's raw error for the "terms not yet accepted"
// case (E_FORBIDDEN + pendingToken) - that's a one-time first-login step we
// don't replicate here; direct the admin to log into PLANKA itself once.
async function login(email, password) {
  const data = await request('/api/access-tokens', {
    method: 'POST',
    body: { emailOrUsername: email, password },
  });

  if (!data.item) {
    if (data.pendingToken) {
      throw new Error(
        'This account has not accepted PLANKA\'s terms yet. Log into PLANKA directly once first, then come back.',
      );
    }
    throw new Error(data.message || 'Login failed');
  }

  return data.item;
}

async function getMe(token, httpOnlyToken) {
  const data = await request('/api/users/me', { token, httpOnlyToken });
  return data.item;
}

async function createUser({ email, password, name }, adminToken) {
  return request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: {
      email,
      password,
      name,
      role: 'boardUser',
    },
  });
}

async function createBoardMembership(boardId, userId, role, adminToken) {
  return request(`/api/boards/${boardId}/board-memberships`, {
    method: 'POST',
    token: adminToken,
    body: { userId, role },
  });
}

// Returns { board, project, projectManagers, boardMemberships } for one
// board id, fetched with the CALLER's own token (not the service account) -
// used to authorize board-scoped actions (e.g. the JSON invite-send and
// gantt-colors routes) without a second API round-trip or the service
// account being involved at all. `projectManagers` is every manager of
// `project`, for a caller-is-manager check; `project.ownerProjectManagerId`
// mirrors the admin-bypass-except-personal-projects rule already used
// elsewhere in this PLANKA deployment. `boardMemberships` is PLANKA's own
// `/api/projects` response scoped to the CALLER's memberships only (per its
// controller: `BoardMembership.qm.getByUserId(currentUser.id)`) - so a
// plain editor/viewer (no manager rights) is still findable in it without a
// second `/api/boards/:id` call.
async function getBoardAuthContext(boardId, token, httpOnlyToken) {
  const data = await request('/api/projects', { token, httpOnlyToken });
  const boardsByProject = data.included && data.included.boards ? data.included.boards : [];
  const board = boardsByProject.find((b) => b.id === boardId);

  if (!board) return null;

  const project = (data.items || []).find((p) => p.id === board.projectId);
  const projectManagers = (data.included && data.included.projectManagers) || [];
  const boardMemberships = (data.included && data.included.boardMemberships) || [];

  return { board, project, projectManagers, boardMemberships };
}

module.exports = {
  PlankaApiError,
  login,
  getMe,
  createUser,
  createBoardMembership,
  getBoardAuthContext,
};
