function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — PLANKA Invites</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.4rem; }
    label { display: block; margin-top: 16px; font-weight: 600; font-size: 0.9rem; }
    input, select { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    button { margin-top: 20px; padding: 10px 18px; background: #1a73e8; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1558b0; }
    .error { background: #fdecea; color: #a33; padding: 10px; border-radius: 4px; margin-top: 16px; }
    .success { background: #eaf6ea; color: #2a6b2a; padding: 10px; border-radius: 4px; margin-top: 16px; }
    .muted { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

function loginPage({ error, csrfToken }) {
  return layout(
    'Admin login',
    `
    <h1>PLANKA Invites — admin login</h1>
    <p class="muted">Log in with your PLANKA admin account to send invites.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/invite/login">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <label>Email or username</label>
      <input type="text" name="emailOrUsername" required autofocus>
      <label>Password</label>
      <input type="password" name="password" required>
      <button type="submit">Log in</button>
    </form>
  `,
  );
}

function invitePage({ boards, error, success, csrfToken, adminEmail, joinUrl }) {
  const options = boards
    .map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.projectName)} / ${escapeHtml(b.name)}</option>`)
    .join('');

  return layout(
    'Send an invite',
    `
    <h1>Invite someone to a board</h1>
    <p class="muted">Logged in as ${escapeHtml(adminEmail)} · <a href="/invite/assign">Batch-assign users</a> · <a href="/invite/logout">Log out</a></p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${success ? `<div class="success">${escapeHtml(success)}</div>` : ''}
    <form method="POST" action="/invite/send">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <label>Their email</label>
      <input type="email" name="email" required>
      <label>Board</label>
      <select name="boardId" required>
        <option value="" disabled selected>Select a board&hellip;</option>
        ${options}
      </select>
      <label>Board role</label>
      <select name="boardRole" required>
        <option value="editor">Editor (can create/edit cards)</option>
        <option value="viewer">Viewer (read-only)</option>
      </select>
      <button type="submit">Send invite</button>
    </form>
    <div style="margin-top:28px;padding:12px;background:#f5f5f5;border-radius:4px;">
      <strong>Self-signup link</strong>
      <p class="muted">Share this once with staff so they can create their own account without you sending individual invites. They still need to be assigned to boards afterward — use "Batch-assign users" above.</p>
      <input type="text" readonly value="${escapeHtml(joinUrl)}" onclick="this.select()" style="font-size:0.85rem;">
    </div>
  `,
  );
}

function joinPage({ error, csrfToken }) {
  return layout(
    'Create your account',
    `
    <h1>Create your PLANKA account</h1>
    <p class="muted">BSY Media internal tool — sign up with your work email.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/invite/join">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <label>Your name</label>
      <input type="text" name="name" required autofocus>
      <p class="muted" style="margin-top:4px;">This is just your display name in PLANKA, not a login name — you'll always log in with your email below.</p>
      <label>Email</label>
      <input type="email" name="email" required>
      <label>Choose a password</label>
      <input type="password" name="password" required minlength="8">
      <p class="muted" style="margin-top:4px;">Must be reasonably strong — a common word plus a few digits (e.g. "password1234") will be rejected.</p>
      <label>Confirm password</label>
      <input type="password" name="passwordConfirm" required minlength="8">
      <button type="submit">Create account</button>
    </form>
    <p class="muted">An admin will assign you to the right boards after you sign up.</p>
  `,
  );
}

function assignPage({ users, boards, error, success, csrfToken, adminEmail }) {
  const userItems = users
    .filter((u) => u.role !== 'admin')
    .map(
      (u) => `<label style="font-weight:400;display:flex;gap:8px;align-items:center;margin-top:6px;">
        <input type="checkbox" name="userIds" value="${escapeHtml(u.id)}"> ${escapeHtml(u.name)} <span class="muted">(${escapeHtml(u.email || u.username || '')})</span>
      </label>`,
    )
    .join('');

  const boardItems = boards
    .map(
      (b) => `<label style="font-weight:400;display:flex;gap:8px;align-items:center;margin-top:6px;">
        <input type="checkbox" name="boardIds" value="${escapeHtml(b.id)}"> ${escapeHtml(b.projectName)} / ${escapeHtml(b.name)}
      </label>`,
    )
    .join('');

  return layout(
    'Batch-assign users',
    `
    <h1>Assign users to boards</h1>
    <p class="muted">Logged in as ${escapeHtml(adminEmail)} · <a href="/invite/">Invite</a> · <a href="/invite/logout">Log out</a></p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${success ? `<div class="success">${escapeHtml(success)}</div>` : ''}
    <form method="POST" action="/invite/assign">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <label>Users</label>
      <div style="max-height:220px;overflow-y:auto;border:1px solid #ccc;border-radius:4px;padding:8px;">
        ${userItems || '<span class="muted">No users found.</span>'}
      </div>
      <label>Boards</label>
      <div style="max-height:220px;overflow-y:auto;border:1px solid #ccc;border-radius:4px;padding:8px;">
        ${boardItems || '<span class="muted">No boards found.</span>'}
      </div>
      <label>Role (applies to all selected boards)</label>
      <select name="boardRole" required>
        <option value="editor">Editor (can create/edit cards)</option>
        <option value="viewer">Viewer (read-only)</option>
      </select>
      <button type="submit">Assign selected users to selected boards</button>
    </form>
  `,
  );
}

function acceptPage({ email, boardName, boardRole, error, csrfToken, token }) {
  return layout(
    'Accept invite',
    `
    <h1>Set up your PLANKA account</h1>
    <p>You've been invited to the <strong>${escapeHtml(boardName)}</strong> board as <strong>${escapeHtml(boardRole)}</strong>.</p>
    <p class="muted">Signing up as ${escapeHtml(email)}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/invite/accept/${escapeHtml(token)}">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <label>Your name</label>
      <input type="text" name="name" required autofocus>
      <p class="muted" style="margin-top:4px;">This is just your display name in PLANKA, not a login name — you'll always log in with your email above.</p>
      <label>Choose a password</label>
      <input type="password" name="password" required minlength="8">
      <p class="muted" style="margin-top:4px;">Must be reasonably strong — a common word plus a few digits (e.g. "password1234") will be rejected.</p>
      <label>Confirm password</label>
      <input type="password" name="passwordConfirm" required minlength="8">
      <button type="submit">Create account</button>
    </form>
  `,
  );
}

function acceptSuccessPage(plankaUrl) {
  return layout(
    'Account created',
    `
    <h1>You're all set</h1>
    <p>Your account has been created. <a href="${escapeHtml(plankaUrl)}">Log into PLANKA</a>.</p>
  `,
  );
}

function messagePage(title, message) {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

module.exports = {
  loginPage,
  invitePage,
  joinPage,
  assignPage,
  acceptPage,
  acceptSuccessPage,
  messagePage,
};
