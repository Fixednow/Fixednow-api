const crypto = require('crypto');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

// A single shared secret is enough here — there's one admin (the person
// running the business), not a team needing individual accounts yet. If
// that changes, this is the file to replace with real admin accounts.
//
// Compared with crypto.timingSafeEqual rather than === so a wrong guess
// can't be brute-forced by measuring how fast it gets rejected.
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin access is not configured on this server (ADMIN_TOKEN not set)' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(ADMIN_TOKEN);
  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
  next();
}

module.exports = { requireAdmin };
