/*
 * auth.cjs -- JSON Web Tokens (HS256), no extra dependency
 * --------------------------------------------------------
 * A token is  base64url(header) . base64url(payload) . base64url(signature)
 * where signature = HMAC-SHA256(secret, "header.payload").
 *
 * Online version: the secret comes from the JWT_SECRET environment variable
 * (set in Render), not from a file, so it survives restarts and is never in
 * the repo. Payload: { sub: <user id>, role, iat, exp }
 */
const crypto = require('node:crypto');

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // one working day; the user logs in again after that
const MIN_SECRET_LEN = 32;

let secret = null;

// `value` is the secret text (or a Buffer). Too-short secrets are refused.
function initAuth(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  if (buf.length < MIN_SECRET_LEN) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
  }
  secret = buf;
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

module.exports = { initAuth, signToken, verifyToken, TOKEN_TTL_SECONDS, MIN_SECRET_LEN };
