const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return {
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
  };
}

function verifyPassword(password, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  const computed = crypto.scryptSync(password, salt, hash.length);
  return crypto.timingSafeEqual(hash, computed);
}

module.exports = { hashPassword, verifyPassword };
