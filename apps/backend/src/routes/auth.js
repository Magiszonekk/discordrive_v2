const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const { hashPassword, verifyPassword } = require('../utils/password');
const { config } = require('../config');
const { sendMail } = require('../services/mailer');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, email: user.email },
    process.env.JWT_SECRET || config.server.jwtSecret || 'changeme',
    { expiresIn: '7d' }
  );
}

router.post('/register', asyncHandler(async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) throw new ApiError(400, 'username, email, password required');

  const existingEmail = db.getUserByEmail(email);
  if (existingEmail) throw new ApiError(400, 'Email already registered');

  const hashed = hashPassword(password);
  const verificationToken = crypto.randomBytes(24).toString('hex');
  const user = db.createUser(username, email, hashed.hash, hashed.salt, verificationToken);

  // Send verification email
  const verifyUrl = `${process.env.PUBLIC_BASE_URL || ''}/api/auth/verify?token=${verificationToken}`;
  await sendMail({
    to: email,
    subject: 'Verify your account',
    text: `Hello ${username}, verify your account: ${verifyUrl}`,
    html: `<p>Hello ${username},</p><p>Verify your account: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });

  res.status(201).json({ success: true, message: 'Registered. Check email to verify.' });
}));

router.get('/verify', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) throw new ApiError(400, 'Token required');
  const user = db.getUserByVerificationToken(token);
  if (!user) throw new ApiError(400, 'Invalid token');
  db.verifyUser(user.id);
  res.json({ success: true, message: 'Verified. You can log in now.' });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new ApiError(400, 'email and password required');
  const user = db.getUserByEmail(email);
  if (!user) throw new ApiError(401, 'Invalid credentials');
  if (!user.verified) throw new ApiError(403, 'Email not verified');
  if (!verifyPassword(password, user.password_salt, user.password_hash)) throw new ApiError(401, 'Invalid credentials');
  const token = signToken(user);

  // Include encrypted key data if available
  const keyData = db.getUserEncryptedKey(user.id);
  const response = {
    success: true,
    token,
    user: { id: user.id, username: user.username, email: user.email },
  };

  if (keyData && keyData.encrypted_key && keyData.key_sync_enabled) {
    response.encryptedKey = keyData.encrypted_key;
    response.encryptedKeySalt = keyData.encrypted_key_salt;
    response.keySyncEnabled = true;
  }

  res.json(response);
}));

router.get('/me', asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, user: req.user });
}));

router.post('/reset/request', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) throw new ApiError(400, 'email required');
  const user = db.getUserByEmail(email);
  if (!user) return res.json({ success: true, message: 'If account exists, email sent.' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 1000 * 60 * 60).toISOString();
  db.setResetToken(user.id, token, expires);
  const resetUrl = `${process.env.PUBLIC_BASE_URL || ''}/reset?token=${token}`;
  await sendMail({
    to: email,
    subject: 'Reset your password',
    text: `Reset your password: ${resetUrl}`,
    html: `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`,
  });
  res.json({ success: true, message: 'If account exists, email sent.' });
}));

router.post('/reset/confirm', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) throw new ApiError(400, 'token and password required');
  const user = db.getUserByResetToken(token);
  if (!user) throw new ApiError(400, 'Invalid token');
  if (user.reset_expires_at && new Date(user.reset_expires_at).getTime() < Date.now()) {
    throw new ApiError(400, 'Reset token expired');
  }
  const hashed = hashPassword(password);
  db.updateUserPassword(user.id, hashed.hash, hashed.salt);
  res.json({ success: true, message: 'Password updated' });
}));

// Verify current user's password (for sensitive operations)
router.post('/verify-password', asyncHandler(async (req, res) => {
  if (!req.user) throw new ApiError(401, 'Unauthorized');

  const { password } = req.body || {};
  if (!password) throw new ApiError(400, 'password required');

  const user = db.getUserById(req.user.id);
  if (!user) throw new ApiError(401, 'User not found');

  const valid = verifyPassword(password, user.password_salt, user.password_hash);
  if (!valid) throw new ApiError(401, 'Invalid password');

  res.json({ success: true, message: 'Password verified' });
}));

// ==================== ENCRYPTED KEY SYNC ====================

// Get encrypted key from server
router.get('/key', asyncHandler(async (req, res) => {
  if (!req.user) throw new ApiError(401, 'Unauthorized');

  const keyData = db.getUserEncryptedKey(req.user.id);

  if (!keyData || !keyData.encrypted_key) {
    return res.json({
      success: true,
      hasKey: false,
      keySyncEnabled: false
    });
  }

  res.json({
    success: true,
    hasKey: true,
    keySyncEnabled: !!keyData.key_sync_enabled,
    encryptedKey: keyData.encrypted_key,
    salt: keyData.encrypted_key_salt
  });
}));

// Save encrypted key to server
router.post('/key', asyncHandler(async (req, res) => {
  if (!req.user) throw new ApiError(401, 'Unauthorized');

  const { encryptedKey, salt, enabled } = req.body || {};

  if (!encryptedKey || !salt) {
    throw new ApiError(400, 'encryptedKey and salt required');
  }

  // Validate base64 format
  if (!/^[A-Za-z0-9+/=]+$/.test(encryptedKey) || !/^[A-Za-z0-9+/=]+$/.test(salt)) {
    throw new ApiError(400, 'Invalid base64 format');
  }

  // Size limits: encrypted key should be ~60-100 bytes base64, salt 32-64 bytes base64
  if (encryptedKey.length > 200 || salt.length > 100) {
    throw new ApiError(400, 'Data too large');
  }

  db.updateUserEncryptedKey(req.user.id, encryptedKey, salt, enabled !== false);

  res.json({ success: true, message: 'Encryption key saved' });
}));

// Delete encrypted key from server
router.delete('/key', asyncHandler(async (req, res) => {
  if (!req.user) throw new ApiError(401, 'Unauthorized');

  db.clearUserEncryptedKey(req.user.id);

  res.json({ success: true, message: 'Encryption key removed from server' });
}));

module.exports = router;
