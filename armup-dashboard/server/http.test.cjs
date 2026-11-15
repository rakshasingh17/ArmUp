/*
 * http.test.cjs -- the real HTTP server, on a random local port.
 * Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db.cjs');
const auth = require('./auth.cjs');
const { configure } = require('./routes.cjs');
const { createServer } = require('./index.cjs');
const { resetTestDatabase, TEST_DATABASE_URL } = require('./test-helpers.cjs');

let server, base;

test.before(async () => {
  await resetTestDatabase();
  auth.initAuth('test-secret-test-secret-test-secret-1234');
  await db.openDb(TEST_DATABASE_URL, { inviteCodes: ['HTTP-CODE-1'], seedDemoPatient: false });
  configure({ demoLogin: false });
  server = createServer({ trustProxy: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.closeDb();
});

const api = async (method, path, body, token, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

test('health check answers without a login (also used to wake the server)', async () => {
  const r = await api('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok', service: 'armup' });
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('sign up, log in, and use the token as a Bearer header', async () => {
  const signup = await api('POST', '/users', { name: 'web-a', password: 'secret12', ailment_tags: ['neck_stiffness'] });
  assert.equal(signup.status, 200);
  const me = await api('GET', `/users/${signup.body.id}`, undefined, signup.body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'web-a');
  assert.equal((await api('GET', `/users/${signup.body.id}`)).status, 401, 'no token');
  assert.equal((await api('GET', `/users/${signup.body.id}`, undefined, 'bad.token.x')).status, 401);
  const again = await api('POST', '/login', { name: 'web-a', password: 'secret12' });
  assert.equal(again.status, 200);
});

test('demo login is off by default on the server', async () => {
  assert.equal((await api('POST', '/demo-login', {})).status, 404);
});

test('bad requests get clear answers, not crashes', async () => {
  assert.equal((await api('POST', '/login', '{not json')).status, 400);
  assert.equal((await api('GET', '/nope')).status, 404);
  assert.equal((await api('PATCH', '/')).status, 404);
  const big = await api('POST', '/login', { name: 'x', password: 'y'.repeat(300 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await api('GET', '/')).status, 200, 'server still fine afterwards');
});

test('too many wrong passwords: 429 with a Retry-After header', async () => {
  configure({});
  let last;
  for (let i = 0; i < 9; i++) {
    last = await api('POST', '/login', { name: 'web-victim', password: 'nope' }, undefined, { 'X-Forwarded-For': `198.51.100.${i}` });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.match(last.body.detail, /Too many tries/);
});

test('the real invite code works once over HTTP', async () => {
  configure({});
  const mk = (name) => api('POST', '/users', { name, password: 'secret12', role: 'therapist', invite_code: 'http-code-1' });
  assert.equal((await mk('web-dr1')).status, 200);
  assert.equal((await mk('web-dr2')).status, 403);
});
