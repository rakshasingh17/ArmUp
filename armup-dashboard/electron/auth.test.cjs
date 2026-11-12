/*
 * auth.test.cjs -- run with:  node --test electron/auth.test.cjs
 * (needs `npm install` first so better-sqlite3 is built)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('./db.cjs');
const auth = require('./auth.cjs');
const { handleRequest } = require('./routes.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'armup-auth-'));
db.openDb(path.join(tmp, 'armup.db'));
auth.initAuth(path.join(tmp, 'jwt-secret.key'));

const call = (method, p, body, token) => handleRequest(method, p, body, token);
const login = (name, password) => call('POST', '/login', { name, password }).body;

const pat = (name, pw = 'secret12') =>
  call('POST', '/users', { name, password: pw, ailment_tags: ['neck_stiffness'] }).body;

test('token: round trip, tampering, expiry, alg none, other secret', () => {
  const t = auth.signToken({ id: 7, role: 'patient' }, 1000);
  assert.deepEqual(auth.verifyToken(t, 1001), { sub: 7, role: 'patient' });
  assert.equal(auth.verifyToken(t, 1000 + auth.TOKEN_TTL_SECONDS), null, 'expired');
  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 7, role: 'therapist', iat: 1000, exp: 9e9 })).toString('base64url');
  assert.equal(auth.verifyToken(`${h}.${forged}.${s}`, 1001), null, 'edited payload');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(auth.verifyToken(`${none}.${p}.`, 1001), null, 'alg none');
  assert.equal(auth.verifyToken('garbage', 1001), null);
  assert.equal(auth.verifyToken(undefined, 1001), null);
});

test('secret file is created once and reused', () => {
  const f = path.join(tmp, 'jwt-secret.key');
  const before = fs.readFileSync(f);
  auth.initAuth(f);
  assert.deepEqual(fs.readFileSync(f), before);
  assert.equal(before.length, 32);
});

test('login and signup return a token and role', () => {
  const u = pat('alice');
  assert.equal(u.role, 'patient');
  assert.ok(u.token);
  const l = login('alice', 'secret12');
  assert.equal(l.role, 'patient');
  assert.ok(l.token);
  assert.equal(call('POST', '/login', { name: 'alice', password: 'nope' }).status, 401);
});

test('protected routes need a valid token', () => {
  assert.equal(call('GET', '/exercises').status, 401);
  assert.equal(call('GET', '/exercises', undefined, 'bad.token.here').status, 401);
  assert.equal(call('GET', '/').status, 200);
  assert.equal(call('GET', '/conditions').status, 200);
});

test('patients see only their own data; therapists see any patient', () => {
  const a = pat('pa');
  const b = pat('pb');
  assert.equal(call('GET', `/users/${a.id}`, undefined, a.token).status, 200);
  assert.equal(call('GET', `/users/${b.id}`, undefined, a.token).status, 403);
  assert.equal(call('GET', `/users/${b.id}/sessions`, undefined, a.token).status, 403);
  assert.equal(call('GET', `/users/${b.id}/exercises`, undefined, a.token).status, 403);

  const th = call('POST', '/users', { name: 'dr1', password: 'secret12', role: 'therapist', invite_code: 'ARMUP-THERAPIST-1' });
  assert.equal(th.status, 200);
  assert.equal(th.body.role, 'therapist');
  assert.equal(call('GET', `/users/${b.id}`, undefined, th.body.token).status, 200);
  assert.equal(call('GET', `/users/${b.id}/sessions`, undefined, th.body.token).status, 200);
});

test('a session can only be saved for yourself', () => {
  const a = pat('sa');
  const b = pat('sb');
  const s = { exercise_key: 'curl', reps: 5, score: 50, accuracy: 80, max_streak: 3, level: 1 };
  assert.equal(call('POST', '/sessions', { ...s, user_id: b.id }, a.token).status, 403);
  assert.equal(db.getHistory(b.id).length, 0, 'nothing written for the other user');
  assert.equal(call('POST', '/sessions', { ...s, user_id: a.id }, a.token).status, 200);
  assert.equal(db.getHistory(a.id).length, 1);
  assert.equal(call('POST', '/sessions', { ...s, user_id: a.id }).status, 401);
});

test('invite codes: patients are refused, therapists get single-use codes', () => {
  const p = pat('ip');
  assert.equal(call('POST', '/invites', {}, p.token).status, 403);
  assert.equal(call('POST', '/invites', {}).status, 401);

  const th = call('POST', '/users', { name: 'dr2', password: 'secret12', role: 'therapist', invite_code: 'armup-therapist-2 ' });
  assert.equal(th.status, 200, 'codes ignore case and surrounding spaces');
  const made = call('POST', '/invites', {}, th.body.token);
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^ARMUP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

  const used = call('POST', '/users', { name: 'dr3', password: 'secret12', role: 'therapist', invite_code: made.body.code });
  assert.equal(used.status, 200);
  assert.equal(used.body.role, 'therapist');
  const again = call('POST', '/users', { name: 'dr4', password: 'secret12', role: 'therapist', invite_code: made.body.code });
  assert.equal(again.status, 403, 'second use of the same code');
  assert.equal(db.getUserByName('dr4'), undefined, 'no account created');
});

test('therapist signup without a valid code is refused and creates nothing', () => {
  for (const code of [undefined, '', 'WRONG', 'ARMUP-THERAPIST-99']) {
    const r = call('POST', '/users', { name: 'sneaky', password: 'secret12', role: 'therapist', invite_code: code });
    assert.equal(r.status, 403);
  }
  assert.equal(db.getUserByName('sneaky'), undefined);
  assert.equal(call('POST', '/users', { name: 'x1', password: 'secret12', role: 'admin', ailment_tags: ['neck_stiffness'] }).status, 400);
});

test('stored codes are hashed, not plain text', () => {
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(tmp, 'armup.db'));
  const hashes = raw.prepare('SELECT code_hash FROM invite_codes').all().map((r) => r.code_hash);
  assert.ok(hashes.length >= 3);
  for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
  raw.close?.();
});

test('tokens for deleted users stop working; role follows the database', () => {
  const g = pat('ghost');
  assert.equal(call('GET', `/users/${g.id}`, undefined, g.token).status, 200);
  const raw = new (require('better-sqlite3'))(path.join(tmp, 'armup.db'));
  raw.prepare("UPDATE users SET role = 'therapist' WHERE id = ?").run(g.id);
  assert.equal(call('POST', '/invites', {}, g.token).status, 200, 'promoted in DB, old token reflects it');
  raw.prepare("UPDATE users SET role = 'patient' WHERE id = ?").run(g.id);
  assert.equal(call('POST', '/invites', {}, g.token).status, 403, 'demoted in DB');
  raw.prepare('DELETE FROM invite_codes WHERE created_by = ?').run(g.id);
  raw.prepare('DELETE FROM users WHERE id = ?').run(g.id);
  assert.equal(call('GET', `/users/${g.id}`, undefined, g.token).status, 401);
  raw.close?.();
});

test('demo login signs in only the Demo Patient', () => {
  const r = call('POST', '/demo-login', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Demo Patient');
  assert.equal(r.body.role, 'patient');
  assert.equal(call('GET', `/users/${r.body.id}`, undefined, r.body.token).status, 200);
});

test('a database from before roles gets the role column, everyone a patient', () => {
  const Database = require('better-sqlite3');
  const old = path.join(tmp, 'old.db');
  const raw = new Database(old);
  raw.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR NOT NULL, ailment_tags VARCHAR DEFAULT '', password_hash VARCHAR);");
  raw.prepare('INSERT INTO users (name, password_hash) VALUES (?, ?)').run('legacy', db.hashPassword('oldpass1'));
  raw.close?.();
  db.openDb(old);
  assert.equal(db.getUserByName('legacy').role, 'patient');
  assert.ok(db.authenticate('legacy', 'oldpass1'));
});
