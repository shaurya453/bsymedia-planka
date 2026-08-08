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
  acceptPage,
  acceptSuccessPage,
  messagePage,
};
