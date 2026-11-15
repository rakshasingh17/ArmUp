/*
 * server-client.test.cjs -- run with:  node --test electron/server-client.test.cjs
 * Uses a throw-away server on this computer; no internet and no Electron needed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServerClient, normalizeUrl } = require('./server-client.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'armup-client-'));
const defaultCfg = path.join(tmp, 'default.json');
fs.writeFileSync(defaultCfg, JSON.stringify({ serverUrl: '' }));

let seen = [];
let mode = 'json';
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
    if (mode === 'html') { res.writeHead(502, { 'Content-Type': 'text/html' }); return res.end('<html>starting</html>'); }
    if (mode === 'hang') return; // never answers
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://evil.example/' }); return res.end(); }
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok","service":"armup"}'); }
    if (req.url === '/secret' && !req.headers.authorization) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"detail":"Please log in again."}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ echoed: raw ? JSON.parse(raw) : null }));
  });
});
let url;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${fake.address().port}`;
});
test.after(() => { fake.closeAllConnections?.(); fake.close(); });

const client = (extra = {}) =>
  createServerClient({ userDataDir: fs.mkdtempSync(path.join(tmp, 'u-')), defaultConfigPath: defaultCfg, env: {}, ...extra });

test('addresses: https is required, except for this computer', () => {
  assert.equal(normalizeUrl('armup-api.onrender.com').url, 'https://armup-api.onrender.com');
  assert.equal(normalizeUrl('  https://armup-api.onrender.com/  ').url, 'https://armup-api.onrender.com');
  assert.equal(normalizeUrl('https://armup-api.onrender.com/some/path?x=1').url, 'https://armup-api.onrender.com');
  assert.equal(normalizeUrl('http://localhost:3000').url, 'http://localhost:3000');
  assert.equal(normalizeUrl('http://127.0.0.1:3000').url, 'http://127.0.0.1:3000');
  assert.equal(normalizeUrl('').url, '');
  for (const bad of ['http://armup-api.onrender.com', 'ftp://x.com', 'https://user:pw@x.com', 'https://', 'http://192.168.1.5:3000']) {
    assert.ok(normalizeUrl(bad).error, bad);
  }
});

test('address order: environment, then saved, then the shipped default', () => {
  const dflt = path.join(tmp, 'with-default.json');
  fs.writeFileSync(dflt, JSON.stringify({ serverUrl: 'https://default.example.com' }));
  const dir = fs.mkdtempSync(path.join(tmp, 'o-'));
  const c = createServerClient({ userDataDir: dir, defaultConfigPath: dflt, env: {} });
  assert.equal(c.getUrl(), 'https://default.example.com');
  assert.equal(c.setUrl('saved.example.com').url, 'https://saved.example.com');
  assert.equal(c.getUrl(), 'https://saved.example.com');
  const withEnv = createServerClient({ userDataDir: dir, defaultConfigPath: dflt, env: { ARMUP_SERVER_URL: 'https://env.example.com' } });
  assert.equal(withEnv.getUrl(), 'https://env.example.com');
  assert.ok(c.setUrl('http://evil.example.com').error, 'refused');
  assert.equal(c.getUrl(), 'https://saved.example.com', 'a refused address changes nothing');
  assert.equal(c.setUrl('').url, 'https://default.example.com', 'empty goes back to the default');
});

test('no address set: a clear message, nothing is sent', async () => {
  const r = await client().forward('GET', '/conditions');
  assert.equal(r.status, 503);
  assert.match(r.body.detail, /No server address/);
});

test('requests carry method, path, JSON body and the Bearer token', async () => {
  const c = client();
  c.setUrl(url);
  seen = []; mode = 'json';
  const r = await c.forward('POST', '/login', { name: 'a', password: 'b' }, 'tok123');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { echoed: { name: 'a', password: 'b' } });
  assert.deepEqual(seen[0], { method: 'POST', url: '/login', auth: 'Bearer tok123', body: '{"name":"a","password":"b"}' });
  seen = [];
  await c.forward('GET', '/users/5/sessions?x=1');
  assert.equal(seen[0].auth, undefined, 'no token, no header');
  assert.equal(seen[0].url, '/users/5/sessions?x=1');
});

test("the server's own error answers pass straight through", async () => {
  const c = client(); c.setUrl(url); mode = 'json';
  const r = await c.forward('GET', '/secret');
  assert.equal(r.status, 401);
  assert.equal(r.body.detail, 'Please log in again.');
});

test('odd methods and paths from the page are refused before sending', async () => {
  const c = client(); c.setUrl(url); seen = []; mode = 'json';
  for (const [m, p] of [['PATCH', '/x'], ['GET', 'conditions'], ['GET', '//evil.example/x'], ['GET', 'http://evil.example/'], ['GET', '/a b'], ['GET', '/a\nb']]) {
    assert.equal((await c.forward(m, p)).status, 400, `${m} ${JSON.stringify(p)}`);
  }
  assert.equal(seen.length, 0);
});

test('hosting-service pages, timeouts, redirects and dead servers become friendly messages', async () => {
  const c = client({ timeoutMs: 300 }); c.setUrl(url);
  mode = 'html';
  let r = await c.forward('GET', '/');
  assert.equal(r.status, 503); assert.match(r.body.detail, /waking up/);
  mode = 'hang';
  r = await c.forward('GET', '/');
  assert.equal(r.status, 503); assert.match(r.body.detail, /too long/);
  mode = 'redirect';
  r = await c.forward('GET', '/');
  assert.equal(r.status, 503); assert.match(r.body.detail, /Can't reach/);
  const dead = client(); dead.setUrl('http://127.0.0.1:9');
  r = await dead.forward('GET', '/');
  assert.equal(r.status, 503); assert.match(r.body.detail, /Can't reach/);
  mode = 'json';
});

test('ping: ready, unreachable, or no address', async () => {
  const c = client(); c.setUrl(url); mode = 'json';
  const ok = await c.ping();
  assert.equal(ok.ok, true); assert.ok(ok.ms >= 0);
  assert.equal((await client().ping()).reason, 'no-address');
  const dead = client(); dead.setUrl('http://127.0.0.1:9');
  const bad = await dead.ping();
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'unreachable');
});
