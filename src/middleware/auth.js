const jwt = require('jsonwebtoken');
const { config } = require('../config');

function attachUser(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const tokenFromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = tokenFromHeader || queryToken;
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || config.server.jwtSecret || 'changeme');
    req.user = { id: payload.sub, username: payload.username, email: payload.email };
  } catch {
    req.user = null;
  }
  return next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = { attachUser, requireAuth };
