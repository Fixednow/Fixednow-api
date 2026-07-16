
Auth · JS
const crypto = require('crypto');
 
// ---------------------------------------------------------------------------
// Password hashing using Node's built-in crypto.scrypt — deliberately not
// using the `bcrypt` package. bcrypt needs native C++ bindings that
// occasionally fail to build on some hosts; scrypt is a well-regarded,
// memory-hard password hashing algorithm built into Node core since v10,
// so this adds zero new dependencies and one less thing to go wrong on
// deploy.
// ---------------------------------------------------------------------------
const SCRYPT_KEYLEN = 64;
 
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt}:${derivedKey.toString('hex')}`;
}
 
function verifyPassword(password, stored) {
  const [salt, hashHex] = (stored || '').split(':');
  if (!salt || !hashHex) return false;
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const storedKey = Buffer.from(hashHex, 'hex');
  if (derivedKey.length !== storedKey.length) return false;
  return crypto.timingSafeEqual(derivedKey, storedKey);
}
 
// ---------------------------------------------------------------------------
// Minimal JWT (HS256) implementation using only crypto.createHmac — same
// reasoning as above: this is a small, well-tested amount of code and
// avoids adding the `jsonwebtoken` package as a dependency.
// ---------------------------------------------------------------------------
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString();
}
 
const DEFAULT_EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30 days
 
function signToken(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + DEFAULT_EXPIRY_SECONDS };
  const headerEnc = base64url(JSON.stringify(header));
  const bodyEnc = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerEnc}.${bodyEnc}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${headerEnc}.${bodyEnc}.${signature}`;
}
 
function verifyToken(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerEnc, bodyEnc, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerEnc}.${bodyEnc}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid signature');
  }
  const payload = JSON.parse(base64urlDecode(bodyEnc));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('Token expired');
  }
  return payload;
}
 
module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
 


