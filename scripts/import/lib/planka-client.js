// Minimal Planka API client for the import tool. Deliberately separate from
// invite-service/src/planka.js (different lifecycle, needs multipart upload
// and many more endpoints) rather than sharing a module across two
// independently-deployed things.
const PLANKA_URL = process.env.PLANKA_INTERNAL_URL || 'http://planka:1337';

class PlankaApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (form) {
    payload = form; // fetch sets multipart Content-Type + boundary itself
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${PLANKA_URL}${path}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new PlankaApiError(data.message || `PLANKA API error (${res.status})`, res.status, data);
  }
  return data;
}

async function login(email, password) {
  const data = await request('/api/access-tokens', {
    method: 'POST',
    body: { emailOrUsername: email, password },
  });
  if (!data.item) throw new Error(data.message || 'Login failed');
  return data.item;
}

async function listUsers(token) {
  const data = await request('/api/users', { token });
  return data.items || [];
}

// Projects, each with included boards (same shape invite-service's listBoards uses).
async function listProjects(token) {
  const data = await request('/api/projects', { token });
  const boards = data.included && data.included.boards ? data.included.boards : [];
  return { projects: data.items || [], boards };
}

async function createProject({ name, description, type = 'shared' }, token) {
  const data = await request('/api/projects', {
    method: 'POST',
    token,
    body: { name, description: description || null, type },
  });
  return data.item;
}

async function createBoard(projectId, { name, position }, token) {
  const data = await request(`/api/projects/${projectId}/boards`, {
    method: 'POST',
    token,
    body: { name, position },
  });
  return data.item;
}

async function createList(boardId, { name, position, type = 'active' }, token) {
  const data = await request(`/api/boards/${boardId}/lists`, {
    method: 'POST',
    token,
    body: { name, position, type },
  });
  return data.item;
}

async function createCard(listId, { name, description, position, dueDate }, token) {
  // dueDate has no `allowNull` on the Sails input side (unlike description) -
  // passing `null` explicitly is rejected, so omit the key entirely instead.
  const body = { type: 'story', name, description: description || null, position };
  if (dueDate) body.dueDate = dueDate;
  const data = await request(`/api/lists/${listId}/cards`, {
    method: 'POST',
    token,
    body,
  });
  return data.item;
}

async function updateCard(cardId, patch, token) {
  const data = await request(`/api/cards/${cardId}`, {
    method: 'PATCH',
    token,
    body: patch,
  });
  return data.item;
}

async function createBoardMembership(boardId, userId, role, token) {
  const data = await request(`/api/boards/${boardId}/board-memberships`, {
    method: 'POST',
    token,
    body: { userId, role },
  });
  return data.item;
}

async function createCardMembership(cardId, userId, token) {
  const data = await request(`/api/cards/${cardId}/card-memberships`, {
    method: 'POST',
    token,
    body: { userId },
  });
  return data.item;
}

async function createComment(cardId, text, token) {
  const data = await request(`/api/cards/${cardId}/comments`, {
    method: 'POST',
    token,
    body: { text },
  });
  return data.item;
}

async function createTaskList(cardId, { name, position }, token) {
  const data = await request(`/api/cards/${cardId}/task-lists`, {
    method: 'POST',
    token,
    body: { name, position },
  });
  return data.item;
}

async function createTask(taskListId, { name, position, isCompleted }, token) {
  const data = await request(`/api/task-lists/${taskListId}/tasks`, {
    method: 'POST',
    token,
    body: { name, position, isCompleted: !!isCompleted },
  });
  return data.item;
}

async function createFileAttachment(cardId, { name, buffer }, token) {
  const form = new FormData();
  form.append('type', 'file');
  form.append('name', name);
  form.append('file', new Blob([buffer]), name);
  const data = await request(`/api/cards/${cardId}/attachments`, {
    method: 'POST',
    token,
    form,
  });
  return data.item;
}

// For count-verification: cards in a list, plus their comments/tasks/attachments counts.
async function getCardsInList(listId, token) {
  const data = await request(`/api/lists/${listId}/cards`, { token });
  return data.items || [];
}

async function getBoard(boardId, token) {
  return request(`/api/boards/${boardId}`, { token });
}

async function getComments(cardId, token) {
  const data = await request(`/api/cards/${cardId}/comments`, { token });
  return data.items || [];
}

module.exports = {
  PlankaApiError,
  login,
  listUsers,
  listProjects,
  createProject,
  createBoard,
  createList,
  createCard,
  updateCard,
  createBoardMembership,
  createCardMembership,
  createComment,
  createTaskList,
  createTask,
  createFileAttachment,
  getCardsInList,
  getBoard,
  getComments,
};
