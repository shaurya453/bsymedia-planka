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

// Returns [{ id, name, projectName, projectId }] for every board the admin
// can see, for the invite form's board dropdown.
async function listBoards(token) {
  const data = await request('/api/projects', { token });
  const boardsByProject = data.included && data.included.boards ? data.included.boards : [];

  const projectNameById = {};
  (data.items || []).forEach((project) => {
    projectNameById[project.id] = project.name;
  });

  return boardsByProject.map((board) => ({
    id: board.id,
    name: board.name,
    projectId: board.projectId,
    projectName: projectNameById[board.projectId] || 'Unknown project',
  }));
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

module.exports = { PlankaApiError, login, getMe, listBoards, createUser, createBoardMembership };
