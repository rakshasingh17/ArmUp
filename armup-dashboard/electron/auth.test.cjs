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

const therapistToken = (name) => login(name, 'secret12').token;

test('notes: therapists write, patients read their own, authors delete', () => {
  const a = pat('note-a');
  const b = pat('note-b');
  const dr1 = therapistToken('dr1');
  const dr2 = therapistToken('dr2');
  const text = (t) => ({ body: t });

  assert.equal(call('POST', `/patients/${a.id}/notes`, text('hi'), a.token).status, 403, 'patient cannot write');
  assert.equal(call('POST', `/patients/${a.id}/notes`, text('hi')).status, 401);
  assert.equal(call('POST', `/patients/${a.id}/notes`, text('   '), dr1).status, 400, 'empty note');
  assert.equal(call('POST', `/patients/${a.id}/notes`, text('x'.repeat(db.NOTE_MAX_LEN + 1)), dr1).status, 400, 'too long');
  assert.equal(call('POST', '/patients/99999/notes', text('hi'), dr1).status, 404, 'no such patient');
  const dr1Id = db.getUserByName('dr1').id;
  assert.equal(call('POST', `/patients/${dr1Id}/notes`, text('hi'), dr1).status, 404, 'cannot target a therapist');

  const n1 = call('POST', `/patients/${a.id}/notes`, text('  Keep the elbow tucked in.  '), dr1);
  assert.equal(n1.status, 200);
  assert.equal(n1.body.body, 'Keep the elbow tucked in.');
  assert.equal(n1.body.therapist_name, 'dr1');
  const n2 = call('POST', `/patients/${a.id}/notes`, text('Great progress this week.'), dr2);

  const mine = call('GET', `/users/${a.id}/notes`, undefined, a.token);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.map((n) => n.body), ['Great progress this week.', 'Keep the elbow tucked in.'], 'newest first');
  assert.equal(call('GET', `/users/${a.id}/notes`, undefined, b.token).status, 403, 'other patient');
  assert.equal(call('GET', `/users/${a.id}/notes`, undefined, dr1).status, 200, 'therapist can read');
  assert.deepEqual(call('GET', `/users/${b.id}/notes`, undefined, b.token).body, [], 'no notes yet');

  assert.equal(call('DELETE', `/notes/${n1.body.id}`, undefined, a.token).status, 403, 'patient cannot delete');
  assert.equal(call('DELETE', `/notes/${n1.body.id}`, undefined, dr2).status, 404, 'not the author');
  assert.equal(call('GET', `/users/${a.id}/notes`, undefined, a.token).body.length, 2, 'still there');
  assert.equal(call('DELETE', `/notes/${n1.body.id}`, undefined, dr1).status, 200, 'author deletes');
  assert.equal(call('GET', `/users/${a.id}/notes`, undefined, a.token).body.length, 1);
  assert.equal(n2.status, 200);
});

test('plan: therapist-only editing, validated, replaces the default, can be reset', () => {
  const a = pat('plan-a'); // neck_stiffness
  const b = pat('plan-b');
  const dr = therapistToken('dr1');
  const put = (token, items) => call('PUT', `/patients/${a.id}/plan`, { exercises: items }, token);

  assert.equal(call('GET', `/patients/${a.id}/plan`, undefined, a.token).status, 403);
  assert.equal(put(a.token, [{ key: 'curl', reps_per_set: 8 }]).status, 403, 'patient cannot edit own plan');
  assert.equal(call('DELETE', `/patients/${a.id}/plan`, undefined, a.token).status, 403);
  assert.equal(put(undefined, [{ key: 'curl', reps_per_set: 8 }]).status, 401);

  // Starting point: the default plan from conditions, pre-ticked.
  const start = call('GET', `/patients/${a.id}/plan`, undefined, dr);
  assert.equal(start.status, 200);
  assert.equal(start.body.custom, false);
  assert.equal(start.body.exercises.length, 4);
  assert.ok(start.body.exercises.some((e) => e.enabled));
  assert.ok(start.body.exercises.every((e) => e.reps_per_set === 10));
  const before = call('GET', `/users/${a.id}/exercises`, undefined, a.token).body;
  assert.ok(before.length >= 1 && before.every((e) => e.custom === false && e.reps_per_set === null));

  // Validation (and a rejected save leaves things as they were).
  for (const bad of [
    [], undefined,
    [{ key: 'nope', reps_per_set: 8 }],
    [{ key: 'curl', reps_per_set: 8 }, { key: 'curl', reps_per_set: 9 }],
    [{ key: 'curl', reps_per_set: db.PLAN_MIN_REPS - 1 }],
    [{ key: 'curl', reps_per_set: db.PLAN_MAX_REPS + 1 }],
    [{ key: 'curl', reps_per_set: 7.5 }],
    [{ key: 'curl', reps_per_set: '8' }],
  ]) {
    assert.equal(put(dr, bad).status, 400, JSON.stringify(bad));
  }
  assert.equal(call('PUT', '/patients/99999/plan', { exercises: [{ key: 'curl', reps_per_set: 8 }] }, dr).status, 404);
  assert.equal(call('GET', `/users/${a.id}/exercises`, undefined, a.token).body.length, before.length, 'unchanged');

  // A real plan: order and reps are kept, and it replaces the default.
  assert.equal(put(dr, [{ key: 'raise', reps_per_set: 8 }, { key: 'curl', reps_per_set: 12 }]).status, 200);
  const mine = call('GET', `/users/${a.id}/exercises`, undefined, a.token).body;
  assert.deepEqual(mine.map((e) => [e.key, e.reps_per_set, e.priority, e.custom]),
    [['raise', 8, 1, true], ['curl', 12, 2, true]]);
  const edit = call('GET', `/patients/${a.id}/plan`, undefined, dr).body;
  assert.equal(edit.custom, true);
  assert.deepEqual(edit.exercises.filter((e) => e.enabled).map((e) => e.key).sort(), ['curl', 'raise']);
  assert.equal(edit.exercises.find((e) => e.key === 'curl').reps_per_set, 12);

  // Saving again replaces (no leftovers), and other patients are unaffected.
  assert.equal(put(dr, [{ key: 'press', reps_per_set: 5 }]).status, 200);
  assert.deepEqual(call('GET', `/users/${a.id}/exercises`, undefined, a.token).body.map((e) => e.key), ['press']);
  assert.ok(call('GET', `/users/${b.id}/exercises`, undefined, b.token).body.every((e) => !e.custom));
  assert.equal(call('GET', `/users/${a.id}/exercises`, undefined, b.token).status, 403);

  // Reset goes back to the default plan.
  assert.equal(call('DELETE', `/patients/${a.id}/plan`, undefined, dr).status, 200);
  const after = call('GET', `/users/${a.id}/exercises`, undefined, a.token).body;
  assert.deepEqual(after.map((e) => e.key), before.map((e) => e.key));
  assert.ok(after.every((e) => !e.custom));
});

test('form faults: saved with a session, cleaned, visible to the therapist', () => {
  const a = pat('form-a');
  const dr = therapistToken('dr1');
  const base = { user_id: a.id, exercise_key: 'curl', reps: 10, score: 90, accuracy: 70, max_streak: 3, level: 1 };

  assert.equal(call('POST', '/sessions', { ...base, form_faults: { elbow_drift: 3, too_high: 0 } }, a.token).status, 200);
  assert.equal(call('POST', '/sessions', { ...base, form_faults: {} }, a.token).status, 200);
  // junk is dropped, not stored: unknown ids, negatives, fractions, strings, huge numbers
  const junk = call('POST', '/sessions', { ...base, form_faults: { elbow_drift: 2, evil: 5, lean_back: -1, too_high: 1.5, x: 'y' } }, a.token);
  assert.equal(junk.status, 200);
  assert.deepEqual(junk.body.form_faults, { elbow_drift: 2 });
  assert.deepEqual(call('POST', '/sessions', { ...base, form_faults: { elbow_drift: 99999 } }, a.token).body.form_faults, { elbow_drift: 1000 });
  // an older client that sends nothing -> "not recorded", which is not the same as "no faults"
  assert.equal(call('POST', '/sessions', base, a.token).body.form_faults, null);
  assert.equal(call('POST', '/sessions', { ...base, form_faults: 'oops' }, a.token).body.form_faults, null);
  assert.equal(call('POST', '/sessions', { ...base, form_faults: [1, 2] }, a.token).body.form_faults, null);

  const seen = call('GET', `/users/${a.id}/sessions`, undefined, dr).body;
  assert.deepEqual(seen[0].form_faults, { elbow_drift: 3 });
  assert.deepEqual(seen[1].form_faults, {});
  assert.equal(seen[4].form_faults, null);
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

test('patient list: therapists only, with a progress summary', () => {
  const a = pat('listed');
  const s = { exercise_key: 'curl', reps: 10, score: 100, accuracy: 80, max_streak: 4, level: 1 };
  call('POST', '/sessions', { ...s, user_id: a.id }, a.token);
  call('POST', '/sessions', { ...s, accuracy: 90, reps: 5, user_id: a.id }, a.token);

  assert.equal(call('GET', '/patients').status, 401);
  assert.equal(call('GET', '/patients', undefined, a.token).status, 403);

  const th = call('POST', '/users', { name: 'dr-list', password: 'secret12', role: 'therapist', invite_code: 'ARMUP-THERAPIST-3' });
  assert.equal(th.status, 200);
  const list = call('GET', '/patients', undefined, th.body.token);
  assert.equal(list.status, 200);
  const row = list.body.find((p) => p.id === a.id);
  assert.equal(row.session_count, 2);
  assert.equal(row.total_reps, 15);
  assert.equal(row.avg_accuracy, 85);
  assert.ok(row.last_session);
  assert.ok(!list.body.some((p) => p.id === th.body.id), 'therapists are not listed as patients');
  assert.ok(list.body.every((p) => !('password_hash' in p) && !('token' in p)));
});
