/*
 * index.cjs -- the ArmUp web server (runs on Render)
 * --------------------------------------------------
 * A thin wrapper: it turns an HTTP request into handleRequest(...) from
 * routes.cjs and sends the answer back as JSON. No web framework.
 *
 * Settings come from environment variables (Render -> Environment):
 *   DATABASE_URL  Postgres connection string (Neon)            required
 *   JWT_SECRET    long random text that signs login tokens     required
 *   INVITE_CODES  comma-separated therapist sign-up codes      optional
 *   ENABLE_DEMO   "1" turns on the Demo Patient + /demo-login  optional
 *   TRUST_PROXY   "1" on Render: the client address comes from X-Forwarded-For
 *   PORT          set by Render
 */
const http = require('node:http');
const db = require('./db.cjs');
const auth = require('./auth.cjs');
const { handleRequest, configure } = require('./routes.cjs');

const MAX_BODY_BYTES = 200 * 1024; // set recordings are off, so requests are small
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
}

// Reads the request body, giving up if it is too big.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop collecting, but keep the connection until the 413 has been sent.
        if (size - chunk.length <= MAX_BODY_BYTES) reject(Object.assign(new Error('too large'), { status: 413 }));
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function createServer({ trustProxy = false } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!METHODS.has(req.method)) return send(res, 404, { detail: 'Not found' });

      let body;
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        if (raw.length) {
          try {
            body = JSON.parse(raw);
          } catch {
            return send(res, 400, { detail: 'That request was not valid JSON.' });
          }
        }
      }

      const header = String(req.headers.authorization || '');
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
      const result = await handleRequest(req.method, req.url || '/', body, token, {
        ip: clientIp(req, trustProxy),
      });
      send(res, result.status, result.body, result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {});
    } catch (err) {
      if (err.status === 413) {
        res.on('finish', () => req.destroy()); // drop the rest of the upload once we've answered
        return send(res, 413, { detail: 'That request is too large.' }, { Connection: 'close' });
      }
      console.error('[armup] server error:', err);
      if (!res.headersSent) send(res, 500, { detail: 'Something went wrong on our side.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

// Neon can take a few seconds to wake; try a few times before giving up.
async function openDbWithRetry(url, options, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await db.openDb(url, options);
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(`[armup] database not ready (attempt ${i}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

async function main() {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  auth.initAuth(env.JWT_SECRET); // throws if missing or too short
  const demo = env.ENABLE_DEMO === '1';
  const inviteCodes = String(env.INVITE_CODES || '').split(',').map((c) => c.trim()).filter(Boolean);

  await openDbWithRetry(env.DATABASE_URL, { inviteCodes, seedDemoPatient: demo });
  configure({ demoLogin: demo });

  const server = createServer({ trustProxy: env.TRUST_PROXY === '1' });
  const port = Number(env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`[armup] listening on port ${port} (demo login ${demo ? 'ON' : 'off'}, ${inviteCodes.length} invite code(s))`);
  });

  const stop = () => {
    console.log('[armup] shutting down');
    server.close(() => db.closeDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[armup] could not start:', err.message);
    process.exit(1);
  });
}

module.exports = { createServer };
