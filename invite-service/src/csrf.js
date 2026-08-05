const crypto = require('crypto');

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function verifyCsrfToken(req, submitted) {
  if (typeof submitted !== 'string' || typeof req.session.csrfToken !== 'string') return false;

  const a = Buffer.from(submitted);
  const b = Buffer.from(req.session.csrfToken);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

module.exports = { ensureCsrfToken, verifyCsrfToken };
