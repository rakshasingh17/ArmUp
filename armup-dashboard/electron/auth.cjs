/*
 * auth.cjs -- JSON Web Tokens (HS256), no extra dependency
 * --------------------------------------------------------
 * A token is  base64url(header) . base64url(payload) . base64url(signature)
 * where signature = HMAC-SHA256(secret, "header.payload").
 *
 * The secret is a random 32-byte value created on first run and kept in the
 * app's own data folder. It lives only in the Electron main process, so the
 * web page can carry a token but can never forge one.
 *
 * Payload: { sub: <user id>, role: 'patient' | 'therapist', iat, exp }
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // one working day; the user logs in again after that

let secret = null;

function initAuth(secretPath) {
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath);
    if (existing.length >= 32) {
      secret = existing;
      return;
    }
  }
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  secret = crypto.randomBytes(32);
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
}

const b64url = (input) => Buffer.from(input).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function signToken(user, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('auth not initialised');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      role: user.role,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_TTL_SECONDS,
    })
  );
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

// Returns { sub, role } for a valid, unexpired token, otherwise null.
function verifyToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  try {
    // Only HS256 is accepted -- this is what blocks the classic alg:"none" trick.
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (head.alg !== 'HS256') return null;

    const expected = Buffer.from(sign(`${header}.${payload}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(claims.sub) || typeof claims.role !== 'string') return null;
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return null;
    return { sub: claims.sub, role: claims.role };
  } catch {
    return null;
  }
}

module.exports = { initAuth, signToken, verifyToken, TOKEN_TTL_SECONDS };
