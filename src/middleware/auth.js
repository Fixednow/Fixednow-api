
Auth · JS
const { verifyToken } = require('../utils/auth');
 
const JWT_SECRET = process.env.JWT_SECRET || 'insecure-dev-secret-do-not-use-in-production';
 
// Verifies the `Authorization: Bearer <token>` header and attaches
// req.user = { id, role }. If `role` is given, also rejects tokens for the
// wrong role — e.g. a customer's token can't hit a provider-only route.
function requireAuth(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    try {
      const payload = verifyToken(token, JWT_SECRET);
      if (role && payload.role !== role) {
        return res.status(403).json({ error: `This action requires a ${role} account` });
      }
      req.user = { id: payload.sub, role: payload.role };
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
 
module.exports = { requireAuth, JWT_SECRET };
 


