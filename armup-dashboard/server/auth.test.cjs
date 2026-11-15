/*
 * auth.test.cjs -- run with:  npm test   (inside the server folder)
 * Needs a PostgreSQL database to test against, named in TEST_DATABASE_URL
 * (default: postgresql://postgres@127.0.0.1:5433/armup_test). The test
 * wipes it, so the database name must contain "test" or the run refuses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db.cjs');
const auth = require('./auth.cjs');
const { handleRequest, configure } = require('./routes.cjs');
const { resetTestDatabase, TEST_DATABASE_URL } = require('./test-helpers.cjs');

const INVITES = ['ARMUP-THERAPIST-1', 'ARMUP-THERAPIST-2', 'ARMUP-THERAPIST-3'];

test.before(async () => {
  await resetTestDatabase();
  auth.initAuth('test-secret-test-secret-test-secret-1234');
  await db.openDb(TEST_DATABASE_URL, { inviteCodes: INVITES, seedDemoPatient: true });
  configure({ demoLogin: true });
});
test.after(async () => { await db.closeDb(); });

const call = (method, p, body, token, ctx) => handleRequest(method, p, body, token, ctx);
const login = async (name, password) => (await call('POST', '/login', { name, password })).body;

const pat = async (name, pw = 'secret12') =>
  (await call('POST', '/users', { name, password: pw, ailment_tags: ['neck_stiffness'] })).body;

test('token: round trip, tampering, expiry, alg none, other secret', async () => {
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

test('login and signup return a token and role', async () => {
  const u = (await pat('alice'));
  assert.equal(u.role, 'patient');
  assert.ok(u.token);
  const l = (await login('alice', 'secret12'));
  assert.equal(l.role, 'patient');
  assert.ok(l.token);
  assert.equal((await call('POST', '/login', { name: 'alice', password: 'nope' })).status, 401);
});

test('protected routes need a valid token', async () => {
  assert.equal((await call('GET', '/exercises')).status, 401);
  assert.equal((await call('GET', '/exercises', undefined, 'bad.token.here')).status, 401);
  assert.equal((await call('GET', '/')).status, 200);
  assert.equal((await call('GET', '/conditions')).status, 200);
});

test('patients see only their own data; therapists see any patient', async () => {
  const a = (await pat('pa'));
  const b = (await pat('pb'));
  assert.equal((await call('GET', `/users/${a.id}`, undefined, a.token)).status, 200);
  assert.equal((await call('GET', `/users/${b.id}`, undefined, a.token)).status, 403);
  assert.equal((await call('GET', `/users/${b.id}/sessions`, undefined, a.token)).status, 403);
  assert.equal((await call('GET', `/users/${b.id}/exercises`, undefined, a.token)).status, 403);

  const th = (await call('POST', '/users', { name: 'dr1', password: 'secret12', role: 'therapist', invite_code: 'ARMUP-THERAPIST-1' }));
  assert.equal(th.status, 200);
  assert.equal(th.body.role, 'therapist');
  assert.equal((await call('GET', `/users/${b.id}`, undefined, th.body.token)).status, 200);
  assert.equal((await call('GET', `/users/${b.id}/sessions`, undefined, th.body.token)).status, 200);
});

test('a session can only be saved for yourself', async () => {
  const a = (await pat('sa'));
  const b = (await pat('sb'));
  const s = { exercise_key: 'curl', reps: 5, score: 50, accuracy: 80, max_streak: 3, level: 1 };
  assert.equal((await call('POST', '/sessions', { ...s, user_id: b.id }, a.token)).status, 403);
  assert.equal((await db.getHistory(b.id)).length, 0, 'nothing written for the other user');
  assert.equal((await call('POST', '/sessions', { ...s, user_id: a.id }, a.token)).status, 200);
  assert.equal((await db.getHistory(a.id)).length, 1);
  assert.equal((await call('POST', '/sessions', { ...s, user_id: a.id })).status, 401);
});

test('invite codes: patients are refused, therapists get single-use codes', async () => {
  const p = (await pat('ip'));
  assert.equal((await call('POST', '/invites', {}, p.token)).status, 403);
  assert.equal((await call('POST', '/invites', {})).status, 401);

  const th = (await call('POST', '/users', { name: 'dr2', password: 'secret12', role: 'therapist', invite_code: 'armup-therapist-2 ' }));
  assert.equal(th.status, 200, 'codes ignore case and surrounding spaces');
  const made = (await call('POST', '/invites', {}, th.body.token));
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^ARMUP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

  const used = (await call('POST', '/users', { name: 'dr3', password: 'secret12', role: 'therapist', invite_code: made.body.code }));
  assert.equal(used.status, 200);
  assert.equal(used.body.role, 'therapist');
  const again = (await call('POST', '/users', { name: 'dr4', password: 'secret12', role: 'therapist', invite_code: made.body.code }));
  assert.equal(again.status, 403, 'second use of the same code');
  assert.equal((await db.getUserByName('dr4')), undefined, 'no account created');
});

test('therapist signup without a valid code is refused and creates nothing', async () => {
  for (const code of [undefined, '', 'WRONG', 'ARMUP-THERAPIST-99']) {
    const r = (await call('POST', '/users', { name: 'sneaky', password: 'secret12', role: 'therapist', invite_code: code }));
    assert.equal(r.status, 403);
  }
  assert.equal((await db.getUserByName('sneaky')), undefined);
  assert.equal((await call('POST', '/users', { name: 'x1', password: 'secret12', role: 'admin', ailment_tags: ['neck_stiffness'] })).status, 400);
});

test('demo login signs in only the Demo Patient', async () => {
  const r = (await call('POST', '/demo-login', {}));
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Demo Patient');
  assert.equal(r.body.role, 'patient');
  assert.equal((await call('GET', `/users/${r.body.id}`, undefined, r.body.token)).status, 200);
});

const therapistToken = async (name) => (await login(name, 'secret12')).token;

test('notes: therapists write, patients read their own, authors delete', async () => {
  const a = (await pat('note-a'));
  const b = (await pat('note-b'));
  const dr1 = (await therapistToken('dr1'));
  const dr2 = (await therapistToken('dr2'));
  const text = (t) => ({ body: t });

  assert.equal((await call('POST', `/patients/${a.id}/notes`, text('hi'), a.token)).status, 403, 'patient cannot write');
  assert.equal((await call('POST', `/patients/${a.id}/notes`, text('hi'))).status, 401);
  assert.equal((await call('POST', `/patients/${a.id}/notes`, text('   '), dr1)).status, 400, 'empty note');
  assert.equal((await call('POST', `/patients/${a.id}/notes`, text('x'.repeat(db.NOTE_MAX_LEN + 1)), dr1)).status, 400, 'too long');
  assert.equal((await call('POST', '/patients/99999/notes', text('hi'), dr1)).status, 404, 'no such patient');
  const dr1Id = (await db.getUserByName('dr1')).id;
  assert.equal((await call('POST', `/patients/${dr1Id}/notes`, text('hi'), dr1)).status, 404, 'cannot target a therapist');

  const n1 = (await call('POST', `/patients/${a.id}/notes`, text('  Keep the elbow tucked in.  '), dr1));
  assert.equal(n1.status, 200);
  assert.equal(n1.body.body, 'Keep the elbow tucked in.');
  assert.equal(n1.body.therapist_name, 'dr1');
  const n2 = (await call('POST', `/patients/${a.id}/notes`, text('Great progress this week.'), dr2));

  const mine = (await call('GET', `/users/${a.id}/notes`, undefined, a.token));
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.map((n) => n.body), ['Great progress this week.', 'Keep the elbow tucked in.'], 'newest first');
  assert.equal((await call('GET', `/users/${a.id}/notes`, undefined, b.token)).status, 403, 'other patient');
  assert.equal((await call('GET', `/users/${a.id}/notes`, undefined, dr1)).status, 200, 'therapist can read');
  assert.deepEqual((await call('GET', `/users/${b.id}/notes`, undefined, b.token)).body, [], 'no notes yet');

  assert.equal((await call('DELETE', `/notes/${n1.body.id}`, undefined, a.token)).status, 403, 'patient cannot delete');
  assert.equal((await call('DELETE', `/notes/${n1.body.id}`, undefined, dr2)).status, 404, 'not the author');
  assert.equal((await call('GET', `/users/${a.id}/notes`, undefined, a.token)).body.length, 2, 'still there');
  assert.equal((await call('DELETE', `/notes/${n1.body.id}`, undefined, dr1)).status, 200, 'author deletes');
  assert.equal((await call('GET', `/users/${a.id}/notes`, undefined, a.token)).body.length, 1);
  assert.equal(n2.status, 200);
});

test('plan: therapist-only editing, validated, replaces the default, can be reset', async () => {
  const a = (await pat('plan-a')); // neck_stiffness
  const b = (await pat('plan-b'));
  const dr = (await therapistToken('dr1'));
  const put = async (token, items) => (await call('PUT', `/patients/${a.id}/plan`, { exercises: items }, token));

  assert.equal((await call('GET', `/patients/${a.id}/plan`, undefined, a.token)).status, 403);
  assert.equal((await put(a.token, [{ key: 'curl', reps_per_set: 8 }])).status, 403, 'patient cannot edit own plan');
  assert.equal((await call('DELETE', `/patients/${a.id}/plan`, undefined, a.token)).status, 403);
  assert.equal((await put(undefined, [{ key: 'curl', reps_per_set: 8 }])).status, 401);

  // Starting point: the default plan from conditions, pre-ticked.
  const start = (await call('GET', `/patients/${a.id}/plan`, undefined, dr));
  assert.equal(start.status, 200);
  assert.equal(start.body.custom, false);
  assert.equal(start.body.exercises.length, 4);
  assert.ok(start.body.exercises.some((e) => e.enabled));
  assert.ok(start.body.exercises.every((e) => e.reps_per_set === 10));
  const before = (await call('GET', `/users/${a.id}/exercises`, undefined, a.token)).body;
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
    assert.equal((await put(dr, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('PUT', '/patients/99999/plan', { exercises: [{ key: 'curl', reps_per_set: 8 }] }, dr)).status, 404);
  assert.equal((await call('GET', `/users/${a.id}/exercises`, undefined, a.token)).body.length, before.length, 'unchanged');

  // A real plan: order and reps are kept, and it replaces the default.
  assert.equal((await put(dr, [{ key: 'raise', reps_per_set: 8 }, { key: 'curl', reps_per_set: 12 }])).status, 200);
  const mine = (await call('GET', `/users/${a.id}/exercises`, undefined, a.token)).body;
  assert.deepEqual(mine.map((e) => [e.key, e.reps_per_set, e.priority, e.custom]),
    [['raise', 8, 1, true], ['curl', 12, 2, true]]);
  const edit = (await call('GET', `/patients/${a.id}/plan`, undefined, dr)).body;
  assert.equal(edit.custom, true);
  assert.deepEqual(edit.exercises.filter((e) => e.enabled).map((e) => e.key).sort(), ['curl', 'raise']);
  assert.equal(edit.exercises.find((e) => e.key === 'curl').reps_per_set, 12);

  // Saving again replaces (no leftovers), and other patients are unaffected.
  assert.equal((await put(dr, [{ key: 'press', reps_per_set: 5 }])).status, 200);
  assert.deepEqual((await call('GET', `/users/${a.id}/exercises`, undefined, a.token)).body.map((e) => e.key), ['press']);
  assert.ok((await call('GET', `/users/${b.id}/exercises`, undefined, b.token)).body.every((e) => !e.custom));
  assert.equal((await call('GET', `/users/${a.id}/exercises`, undefined, b.token)).status, 403);

  // Reset goes back to the default plan.
  assert.equal((await call('DELETE', `/patients/${a.id}/plan`, undefined, dr)).status, 200);
  const after = (await call('GET', `/users/${a.id}/exercises`, undefined, a.token)).body;
  assert.deepEqual(after.map((e) => e.key), before.map((e) => e.key));
  assert.ok(after.every((e) => !e.custom));
});

test('form faults: saved with a session, cleaned, visible to the therapist', async () => {
  const a = (await pat('form-a'));
  const dr = (await therapistToken('dr1'));
  const base = { user_id: a.id, exercise_key: 'curl', reps: 10, score: 90, accuracy: 70, max_streak: 3, level: 1 };

  assert.equal((await call('POST', '/sessions', { ...base, form_faults: { elbow_drift: 3, too_high: 0 } }, a.token)).status, 200);
  assert.equal((await call('POST', '/sessions', { ...base, form_faults: {} }, a.token)).status, 200);
  // junk is dropped, not stored: unknown ids, negatives, fractions, strings, huge numbers
  const junk = (await call('POST', '/sessions', { ...base, form_faults: { elbow_drift: 2, evil: 5, lean_back: -1, too_high: 1.5, x: 'y' } }, a.token));
  assert.equal(junk.status, 200);
  assert.deepEqual(junk.body.form_faults, { elbow_drift: 2 });
  assert.deepEqual((await call('POST', '/sessions', { ...base, form_faults: { elbow_drift: 99999 } }, a.token)).body.form_faults, { elbow_drift: 1000 });
  // an older client that sends nothing -> "not recorded", which is not the same as "no faults"
  assert.equal((await call('POST', '/sessions', base, a.token)).body.form_faults, null);
  assert.equal((await call('POST', '/sessions', { ...base, form_faults: 'oops' }, a.token)).body.form_faults, null);
  assert.equal((await call('POST', '/sessions', { ...base, form_faults: [1, 2] }, a.token)).body.form_faults, null);

  const seen = (await call('GET', `/users/${a.id}/sessions`, undefined, dr)).body;
  assert.deepEqual(seen[0].form_faults, { elbow_drift: 3 });
  assert.deepEqual(seen[1].form_faults, {});
  assert.equal(seen[4].form_faults, null);
});

test('patient list: therapists only, with a progress summary', async () => {
  const a = (await pat('listed'));
  const s = { exercise_key: 'curl', reps: 10, score: 100, accuracy: 80, max_streak: 4, level: 1 };
  (await call('POST', '/sessions', { ...s, user_id: a.id }, a.token));
  (await call('POST', '/sessions', { ...s, accuracy: 90, reps: 5, user_id: a.id }, a.token));

  assert.equal((await call('GET', '/patients')).status, 401);
  assert.equal((await call('GET', '/patients', undefined, a.token)).status, 403);

  const th = (await call('POST', '/users', { name: 'dr-list', password: 'secret12', role: 'therapist', invite_code: 'ARMUP-THERAPIST-3' }));
  assert.equal(th.status, 200);
  const list = (await call('GET', '/patients', undefined, th.body.token));
  assert.equal(list.status, 200);
  const row = list.body.find((p) => p.id === a.id);
  assert.equal(row.session_count, 2);
  assert.equal(row.total_reps, 15);
  assert.equal(row.avg_accuracy, 85);

  // Koi chase is saved at 100% (no misses), so it must not lift the average.
  (await call('POST', '/sessions', { exercise_key: 'koi', reps: 12, score: 120, accuracy: 100, max_streak: 3, level: 1, form_faults: {}, user_id: a.id }, a.token));
  const row2 = (await call('GET', '/patients', undefined, th.body.token)).body.find((p) => p.id === a.id);
  assert.equal(row2.session_count, 3);
  assert.equal(row2.avg_accuracy, 85);
  assert.ok(row.last_session);
  assert.ok(!list.body.some((p) => p.id === th.body.id), 'therapists are not listed as patients');
  assert.ok(list.body.every((p) => !('password_hash' in p) && !('token' in p)));
});

test('koi chase: sessions can be saved, but it is not a prescribable exercise', async () => {
  const a = (await pat('koi-a'));
  const dr = (await call('POST', '/users', { name: 'dr-koi', password: 'secret12', role: 'therapist', invite_code: await db.createInviteCode(null) })).body.token;
  const s = { exercise_key: 'koi', reps: 8, score: 80, accuracy: 100, max_streak: 2, level: 1, form_faults: {} };
  assert.equal((await call('POST', '/sessions', { ...s, user_id: a.id }, a.token)).status, 200);
  assert.equal((await db.getHistory(a.id))[0].exercise_key, 'koi');
  assert.equal((await call('POST', '/sessions', { ...s, exercise_key: 'nope', user_id: a.id }, a.token)).status, 400);
  // Not offered in the therapist's plan editor, and cannot be put in a plan.
  const plan = (await call('GET', `/patients/${a.id}/plan`, undefined, dr)).body;
  assert.ok(!plan.exercises.some((e) => e.key === 'koi'));
  assert.equal((await call('PUT', `/patients/${a.id}/plan`, { exercises: [{ key: 'koi', reps_per_set: 8 }] }, dr)).status, 400);
  assert.ok(!(await call('GET', '/exercises', undefined, a.token)).body.some((e) => e.key === 'koi'));
});


// ---------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------
const appts = require('./appointments.cjs');
const inDays = (d, hour = 10) => {
  const t = new Date(Date.now() + d * 86400000);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};
const therapist = async (name) => (await call('POST', '/users', { name, password: 'secret12', role: 'therapist', invite_code: (await db.createInviteCode(null)) })).body;

test('appointment rules: who can do what, in which status', async () => {
  assert.equal(appts.nextStatus('patient', 'scheduled', 'confirm'), 'confirmed');
  assert.equal(appts.nextStatus('patient', 'requested', 'confirm'), null, 'a patient cannot confirm their own request');
  assert.equal(appts.nextStatus('therapist', 'requested', 'approve'), 'confirmed');
  assert.equal(appts.nextStatus('therapist', 'scheduled', 'approve'), null);
  assert.equal(appts.nextStatus('patient', 'requested', 'approve'), null, 'patients cannot approve');
  assert.equal(appts.nextStatus('therapist', 'confirmed', 'reschedule'), 'scheduled');
  assert.equal(appts.nextStatus('patient', 'confirmed', 'reschedule'), 'requested');
  for (const done of ['cancelled', 'declined', 'completed']) {
    for (const role of ['patient', 'therapist']) {
      for (const action of ['confirm', 'approve', 'decline', 'cancel', 'complete', 'reschedule']) {
        assert.equal(appts.nextStatus(role, done, action), null, `${role} ${action} on ${done}`);
      }
    }
  }
});

test('appointment rules: times, lengths, notes, overlaps', async () => {
  const now = new Date('2026-11-15T00:00:00Z');
  assert.ok(appts.parseStart('2026-11-16T10:00:00Z', now).date);
  assert.ok(appts.parseStart('2026-11-14T10:00:00Z', now).error, 'past');
  assert.ok(appts.parseStart('not a date', now).error);
  assert.ok(appts.parseStart(undefined, now).error);
  assert.ok(appts.parseStart('2030-01-01T10:00:00Z', now).error, 'too far ahead');
  assert.equal(appts.cleanDuration(undefined), 30);
  assert.equal(appts.cleanDuration('45'), 45);
  assert.equal(appts.cleanDuration(50), null);
  assert.ok(appts.cleanNote('x'.repeat(301)).error);
  assert.equal(appts.cleanNote('  hi  ').note, 'hi');
  assert.equal(appts.overlaps('2026-11-20T10:00:00Z', 30, '2026-11-20T10:15:00Z', 30), true);
  assert.equal(appts.overlaps('2026-11-20T10:00:00Z', 30, '2026-11-20T10:30:00Z', 30), false, 'back to back is fine');
});

test('appointments: therapist books, patient confirms, double-booking is refused', async () => {
  const dr = (await therapist('dr-appt-1'));
  const a = (await pat('appt-a'));
  const b = (await pat('appt-b'));

  // Only therapists can book for a patient; patients can't pick another patient.
  assert.equal((await call('POST', '/appointments', { patient_id: b.id, therapist_id: dr.id, starts_at: inDays(2) }, a.token)).body.status, 'requested');
  const booked = (await call('POST', '/appointments', { patient_id: a.id, starts_at: inDays(3), duration_min: 45, note: 'Bring your elbow brace' }, dr.token));
  assert.equal(booked.status, 200);
  assert.equal(booked.body.status, 'scheduled');
  assert.equal(booked.body.requested_by, 'therapist');
  assert.equal(booked.body.duration_min, 45);
  assert.equal(booked.body.note, 'Bring your elbow brace');

  // The same therapist cannot be booked twice at that time, by anyone.
  assert.equal((await call('POST', '/appointments', { patient_id: b.id, starts_at: inDays(3) }, dr.token)).status, 409);
  assert.equal((await call('POST', '/appointments', { therapist_id: dr.id, starts_at: inDays(3) }, b.token)).status, 409);

  // The patient sees it and confirms; nobody else can touch it.
  assert.equal((await call('GET', '/appointments', undefined, a.token)).body.filter((x) => x.id === booked.body.id).length, 1);
  assert.equal((await call('GET', '/appointments', undefined, b.token)).body.some((x) => x.id === booked.body.id), false);
  assert.equal((await call('POST', `/appointments/${booked.body.id}/confirm`, {}, b.token)).status, 404);
  const confirmed = (await call('POST', `/appointments/${booked.body.id}/confirm`, {}, a.token));
  assert.equal(confirmed.body.status, 'confirmed');
  // Cannot confirm twice.
  assert.equal((await call('POST', `/appointments/${booked.body.id}/confirm`, {}, a.token)).status, 409);
});

test('appointments: patient requests, therapist approves or declines', async () => {
  const dr = (await therapist('dr-appt-2'));
  const other = (await therapist('dr-appt-3'));
  const a = (await pat('appt-c'));

  assert.equal((await call('POST', '/appointments', { therapist_id: a.id, starts_at: inDays(4) }, a.token)).status, 404, 'not a therapist');
  assert.equal((await call('POST', '/appointments', { therapist_id: dr.id, starts_at: inDays(-1) }, a.token)).status, 400, 'past');
  assert.equal((await call('POST', '/appointments', { therapist_id: dr.id, starts_at: inDays(4), duration_min: 50 }, a.token)).status, 400);
  assert.equal((await call('POST', '/appointments', { therapist_id: dr.id }, a.token)).status, 400, 'no time');

  const req = (await call('POST', '/appointments', { therapist_id: dr.id, starts_at: inDays(4), note: 'Shoulder is stiff' }, a.token)).body;
  assert.equal(req.status, 'requested');
  assert.equal((await call('POST', `/appointments/${req.id}/approve`, {}, a.token)).status, 409, 'patient cannot approve');
  assert.equal((await call('POST', `/appointments/${req.id}/approve`, {}, other.token)).status, 404, 'another therapist cannot');
  assert.equal((await call('POST', `/appointments/${req.id}/approve`, {}, dr.token)).body.status, 'confirmed');

  const req2 = (await call('POST', '/appointments', { therapist_id: dr.id, starts_at: inDays(5) }, a.token)).body;
  assert.equal((await call('POST', `/appointments/${req2.id}/decline`, {}, dr.token)).body.status, 'declined');
  assert.equal((await call('POST', `/appointments/${req2.id}/cancel`, {}, a.token)).status, 409, 'already closed');
  // The declined slot is free again.
  assert.equal((await call('POST', '/appointments', { therapist_id: dr.id, starts_at: inDays(5) }, a.token)).status, 200);

  // Therapists only see their own appointments.
  assert.equal((await call('GET', '/appointments', undefined, other.token)).body.length, 0);
  assert.ok((await call('GET', '/therapists', undefined, a.token)).body.some((t) => t.id === dr.id));
});

test('appointments: rescheduling hands the decision to the other side', async () => {
  const dr = (await therapist('dr-appt-4'));
  const a = (await pat('appt-d'));
  const booked = (await call('POST', '/appointments', { patient_id: a.id, starts_at: inDays(6) }, dr.token)).body;
  (await call('POST', `/appointments/${booked.id}/confirm`, {}, a.token));

  // Patient suggests a new time -> back to "requested", therapist must approve.
  const moved = (await call('POST', `/appointments/${booked.id}/reschedule`, { starts_at: inDays(7) }, a.token)).body;
  assert.equal(moved.status, 'requested');
  assert.equal(moved.requested_by, 'patient');
  assert.equal(moved.starts_at.slice(0, 10), inDays(7).slice(0, 10));
  assert.equal((await call('POST', `/appointments/${booked.id}/reschedule`, { starts_at: inDays(-2) }, a.token)).status, 400);
  assert.equal((await call('POST', `/appointments/${booked.id}/approve`, {}, dr.token)).body.status, 'confirmed');

  // Therapist moves it -> "scheduled", the patient must confirm again.
  const moved2 = (await call('POST', `/appointments/${booked.id}/reschedule`, { starts_at: inDays(8) }, dr.token)).body;
  assert.equal(moved2.status, 'scheduled');
  assert.equal(moved2.requested_by, 'therapist');
  assert.equal((await call('POST', `/appointments/${booked.id}/cancel`, {}, a.token)).body.status, 'cancelled');
});

test('appointments: completing needs the start time to have passed', async () => {
  const dr = (await therapist('dr-appt-5'));
  const a = (await pat('appt-e'));
  const future = (await call('POST', '/appointments', { patient_id: a.id, starts_at: inDays(2) }, dr.token)).body;
  assert.equal((await call('POST', `/appointments/${future.id}/complete`, {}, dr.token)).status, 409);

  const past = (await db.createAppointment({
    patientId: a.id, therapistId: dr.id, startsAt: new Date(Date.now() - 86400000), durationMin: 30,
    note: '', status: 'confirmed', requestedBy: 'therapist',
  }));
  assert.equal((await call('POST', `/appointments/${past.id}/complete`, {}, a.token)).status, 409, 'patients cannot complete');
  assert.equal((await call('POST', `/appointments/${past.id}/complete`, {}, dr.token)).body.status, 'completed');
});

test('appointments: need a login, and a therapist can only book real patients', async () => {
  assert.equal((await call('GET', '/appointments')).status, 401);
  assert.equal((await call('POST', '/appointments', { patient_id: 1, starts_at: inDays(2) })).status, 401);
  const dr = (await therapist('dr-appt-6'));
  const other = (await therapist('dr-appt-7'));
  assert.equal((await call('POST', '/appointments', { patient_id: other.id, starts_at: inDays(2) }, dr.token)).status, 404, 'not a patient');
  assert.equal((await call('POST', '/appointments', { patient_id: 99999, starts_at: inDays(2) }, dr.token)).status, 404);
});


// ---------------------------------------------------------------
// New for the online version
// ---------------------------------------------------------------
test('the token secret must be long enough', () => {
  assert.throws(() => auth.initAuth(undefined), /JWT_SECRET/);
  assert.throws(() => auth.initAuth('short'), /JWT_SECRET/);
  auth.initAuth('test-secret-test-secret-test-secret-1234'); // put the real one back
});

test('stored invite codes are hashed, not plain text', async () => {
  const { rows } = await db.query('SELECT code_hash FROM invite_codes');
  assert.ok(rows.length >= 3);
  for (const r of rows) assert.match(r.code_hash, /^[0-9a-f]{64}$/);
});

test('tokens for deleted users stop working; role follows the database', async () => {
  const g = await pat('ghost');
  assert.equal((await call('GET', `/users/${g.id}`, undefined, g.token)).status, 200);
  await db.query("UPDATE users SET role = 'therapist' WHERE id = $1", [g.id]);
  assert.equal((await call('POST', '/invites', {}, g.token)).status, 200, 'promoted in DB, old token reflects it');
  await db.query("UPDATE users SET role = 'patient' WHERE id = $1", [g.id]);
  assert.equal((await call('POST', '/invites', {}, g.token)).status, 403, 'demoted in DB');
  await db.query('DELETE FROM invite_codes WHERE created_by = $1', [g.id]);
  await db.query('DELETE FROM users WHERE id = $1', [g.id]);
  assert.equal((await call('GET', `/users/${g.id}`, undefined, g.token)).status, 401);
});

test('names are unique, ignoring case, even when two sign-ups race', async () => {
  const body = (n) => ({ name: n, password: 'secret12', ailment_tags: ['neck_stiffness'] });
  const results = await Promise.all([
    call('POST', '/users', body('Racer')),
    call('POST', '/users', body('racer')),
    call('POST', '/users', body('RACER')),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
});

test('ids that are huge or not numbers are "not found", never a crash', async () => {
  const a = await pat('bigid');
  const dr = (await call('POST', '/users', { name: 'dr-bigid', password: 'secret12', role: 'therapist', invite_code: await db.createInviteCode(null) })).body;
  assert.equal((await call('GET', '/users/99999999999999999999', undefined, dr.token)).status, 404);
  assert.equal((await call('GET', '/users/99999999999999999999/sessions', undefined, dr.token)).status, 404);
  assert.equal((await call('POST', '/patients/99999999999999999999/notes', { body: 'x' }, dr.token)).status, 404);
  assert.equal((await call('DELETE', '/notes/99999999999999999999', undefined, dr.token)).status, 404);
  assert.equal((await call('POST', '/appointments/99999999999999999999/cancel', {}, a.token)).status, 404);
  assert.equal((await call('GET', '/sessions/99999999999999999999/recording', undefined, a.token)).status, 404);
});

test('session numbers outside a sane range are refused', async () => {
  const a = await pat('bignum');
  const s = { user_id: a.id, exercise_key: 'curl', reps: 5, score: 50, accuracy: 80, max_streak: 3, level: 1 };
  assert.equal((await call('POST', '/sessions', { ...s, reps: 1e12 }, a.token)).status, 422);
  assert.equal((await call('POST', '/sessions', { ...s, score: -5 }, a.token)).status, 422);
  assert.equal((await call('POST', '/sessions', s, a.token)).status, 200);
});

test('demo login is off unless the server turns it on', async () => {
  configure({ demoLogin: false });
  assert.equal((await call('POST', '/demo-login', {})).status, 404);
  configure({ demoLogin: true });
  assert.equal((await call('POST', '/demo-login', {})).status, 200);
});

test('wrong passwords are rate-limited per name, and a good login still works before the limit', async () => {
  let clock = 1_000_000;
  configure({ now: () => clock });
  const a = await pat('limited');
  const bad = (ip) => call('POST', '/login', { name: 'limited', password: 'wrong-one' }, undefined, { ip });

  for (let i = 0; i < 8; i++) assert.equal((await bad(`10.0.0.${i}`)).status, 401);
  const blocked = await bad('10.9.9.9');
  assert.equal(blocked.status, 429, 'ninth try is refused, even from a new address');
  assert.ok(blocked.retryAfter > 0);
  assert.equal((await call('POST', '/login', { name: 'limited', password: 'secret12' }, undefined, { ip: '10.8.8.8' })).status, 429,
    'even the right password waits');
  assert.equal((await login('someone-else', 'x')).detail, 'Incorrect name or password.', 'other names are not affected');

  clock += 16 * 60 * 1000; // 16 minutes later
  assert.equal((await call('POST', '/login', { name: 'limited', password: 'secret12' }, undefined, { ip: '10.8.8.8' })).status, 200);
  assert.ok(a.token);
  configure({ now: () => Date.now() });
});

test('wrong passwords are also limited per address, across many names', async () => {
  configure({ now: () => Date.now() });
  const ip = '203.0.113.7';
  let last;
  for (let i = 0; i < 41; i++) {
    last = await call('POST', '/login', { name: `nobody-${i}`, password: 'x' }, undefined, { ip });
  }
  assert.equal(last.status, 429);
  assert.equal((await call('POST', '/login', { name: 'nobody-x', password: 'x' }, undefined, { ip: '203.0.113.8' })).status, 401);
  configure({});
});

test('wrong invite codes are rate-limited per address', async () => {
  configure({ now: () => Date.now() });
  const ip = '198.51.100.4';
  const tryCode = (code) => call('POST', '/users', { name: `guess-${Math.random()}`, password: 'secret12', role: 'therapist', invite_code: code }, undefined, { ip });
  for (let i = 0; i < 10; i++) assert.equal((await tryCode(`WRONG-${i}`)).status, 403);
  assert.equal((await tryCode('WRONG-11')).status, 429);
  assert.equal((await tryCode(await db.createInviteCode(null))).status, 429, 'blocked even with a real code');
  configure({});
});

test('SQL injection attempts are just wrong names/passwords', async () => {
  const evil = "' OR '1'='1'; DROP TABLE users; --";
  assert.equal((await call('POST', '/login', { name: evil, password: evil }, undefined, { ip: '192.0.2.1' })).status, 401);
  assert.equal((await call('POST', '/users', { name: evil, password: 'secret12', ailment_tags: ['neck_stiffness'] })).status, 200);
  assert.equal((await db.getUserByName(evil)).name, evil, 'stored as plain text');
  assert.ok((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n > 5, 'users table is intact');
});

test('recordings are off online: consent works, uploads are refused, nothing to watch', async () => {
  const a = await pat('rec-a');
  const dr = await therapistToken('dr1');
  assert.equal(a.share_recordings, false);
  assert.equal((await call('PUT', `/users/${a.id}/recording-consent`, { share_recordings: true }, a.token)).status, 200);
  assert.equal((await call('GET', `/users/${a.id}`, undefined, a.token)).body.share_recordings, true);
  const s = (await call('POST', '/sessions', { user_id: a.id, exercise_key: 'curl', reps: 10, score: 90, accuracy: 80, max_streak: 3, level: 1 }, a.token)).body;
  assert.equal(s.has_recording, false);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('video')]).toString('base64');
  assert.equal((await call('POST', `/sessions/${s.id}/recording`, { data: webm }, a.token)).status, 403);
  assert.equal((await call('GET', `/sessions/${s.id}/recording`, undefined, dr)).status, 404);
  assert.equal((await call('GET', `/sessions/${s.id}/recording`, undefined, a.token)).status, 404);
  assert.equal((await call('POST', `/sessions/${s.id}/recording`, { data: webm })).status, 401, 'still needs a login');
});

test('double-booking: two bookings for one slot at the same moment, only one wins', async () => {
  const dr = await therapist('dr-race');
  const [p1, p2] = [await pat('race-1'), await pat('race-2')];
  const start = inDays(9);
  const [r1, r2] = await Promise.all([
    call('POST', '/appointments', { patient_id: p1.id, starts_at: start }, dr.token),
    call('POST', '/appointments', { patient_id: p2.id, starts_at: start }, dr.token),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
});

test('timestamps come back as ISO text in UTC', async () => {
  const dr = await therapist('dr-iso');
  const a = await pat('iso-a');
  const at = inDays(10, 14);
  const made = (await call('POST', '/appointments', { patient_id: a.id, starts_at: at }, dr.token)).body;
  assert.equal(made.starts_at, at);
  const s = (await call('POST', '/sessions', { user_id: a.id, exercise_key: 'curl', reps: 1, score: 1, accuracy: 1, max_streak: 1, level: 1 }, a.token)).body;
  assert.match(s.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/);
});
