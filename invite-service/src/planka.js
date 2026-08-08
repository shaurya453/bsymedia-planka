const PLANKA_URL = process.env.PLANKA_INTERNAL_URL || 'http://planka:1337';

class PlankaApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

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

async function getMe(token) {
  const data = await request('/api/users/me', { token });
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

// Returns { board, project, projectManagers } for one board id, fetched
// with the CALLER's own token (not the service account) - used to
// authorize board-scoped actions (e.g. the JSON invite-send route) without
// a second API round-trip or the service account being involved at all.
// `projectManagers` is every manager of `project`, for a caller-is-manager
// check; `project.ownerProjectManagerId` mirrors the admin-bypass-except-
// personal-projects rule already used elsewhere in this PLANKA deployment.
async function getBoardAuthContext(boardId, token) {
  const data = await request('/api/projects', { token });
  const boardsByProject = data.included && data.included.boards ? data.included.boards : [];
  const board = boardsByProject.find((b) => b.id === boardId);

  if (!board) return null;

  const project = (data.items || []).find((p) => p.id === board.projectId);
  const projectManagers = (data.included && data.included.projectManagers) || [];

  return { board, project, projectManagers };
}

module.exports = {
  PlankaApiError,
  login,
  getMe,
  createUser,
  createBoardMembership,
  getBoardAuthContext,
};
