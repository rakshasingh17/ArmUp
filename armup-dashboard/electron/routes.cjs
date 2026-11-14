/*
 * routes.cjs -- Node port of backend/armup_api.py
 * -----------------------------------------------
 * Same paths, same validation messages, same JSON shapes as the FastAPI
 * version, so the React pages don't care what is behind them.
 *
 * handleRequest(method, path, body, token) -> { status, body }
 * No HTTP server involved: main.cjs calls this through Electron IPC.
 * (The dead POST /start-session route is intentionally not ported.)
 */
const db = require('./db.cjs');
const auth = require('./auth.cjs');
const recordings = require('./recordings.cjs');

const MIN_PASSWORD_LEN = 6; // keep in sync with SignupPage.jsx

const ok = (body) => ({ status: 200, body });
const fail = (status, detail) => ({ status, body: { detail } });

// A route is public unless declared otherwise. Protected handlers receive the
// verified token claims as `who` ({ sub, role }); the user id always comes
// from the token, never from anything the page sends.
const routes = [];
const route = (method, pattern, handler, { public: isPublic = false } = {}) =>
  routes.push({ method, pattern, handler, isPublic });

// Matches SET_REPS in ExerciseCanvas.jsx (the set size when no plan says otherwise).
const DEFAULT_SET_REPS = 10;
const isTherapist = (who) => who.role === 'therapist';
// A patient may touch only their own records; a therapist may read any patient's.
const canReadUser = (who, id) => who.sub === id || isTherapist(who);

// Login/signup answer: the public user plus a fresh token.
const withToken = (user) => ({ ...db.publicUser(user), token: auth.signToken(user) });

route('GET', /^\/$/, () => ok({ status: 'ok', service: 'armup' }), { public: true });

route('GET', /^\/conditions$/, () => ok(db.listConditions()), { public: true });

route('POST', /^\/users$/, (_p, body) => {
  const name = String(body?.name ?? '').trim();
  const password = String(body?.password ?? '');
  const role = body?.role === undefined ? 'patient' : body.role;
  if (!db.ROLES.includes(role)) return fail(400, 'Unknown role.');
  if (!name) return fail(400, 'Please enter your name.');
  if (password.length < MIN_PASSWORD_LEN) {
    return fail(400, `Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  if (db.getUserByName(name)) {
    return fail(409, "That name is already taken. Choose another, or log in if it's yours.");
  }

  if (role === 'therapist') {
    // Therapist accounts need a single-use invite code, checked here (not in
    // the page) so it can't be skipped by editing the UI.
    const therapist = db.createTherapistWithInvite(name, password, String(body?.invite_code ?? ''));
    return therapist
      ? ok(withToken(therapist))
      : fail(403, "That invite code isn't valid or has already been used.");
  }

  const tags = [...new Set(Array.isArray(body?.ailment_tags) ? body.ailment_tags : [])];
  if (!tags.length) return fail(400, 'Select at least one condition.');
  const valid = new Set(db.listConditions().map((c) => c.tag));
  const unknown = tags.find((t) => !valid.has(t));
  if (unknown) return fail(400, `Unknown condition: ${unknown}`);
  return ok(withToken(db.createUser(name, tags, password, 'patient')));
}, { public: true });

route('POST', /^\/login$/, (_p, body) => {
  const user = db.authenticate(String(body?.name ?? ''), String(body?.password ?? ''));
  // Same message for "no such name" and "wrong password" on purpose.
  return user ? ok(withToken(user)) : fail(401, 'Incorrect name or password.');
}, { public: true });

// "Continue as test patient" on the landing page. Only ever signs in the
// seeded "Demo Patient" account, never anyone else.
route('POST', /^\/demo-login$/, () => {
  const user = db.getUserByName('Demo Patient');
  return user && user.role === 'patient' ? ok(withToken(user)) : fail(404, 'Demo account not found.');
}, { public: true });

// Therapists can invite other therapists. Patients get 403.
route('POST', /^\/invites$/, (_p, _body, who) => {
  if (!isTherapist(who)) return fail(403, 'Only therapists can create invite codes.');
  return ok({ code: db.createInviteCode(who.sub) });
});

// The therapist's patient list. Patients get 403.
route('GET', /^\/patients$/, (_p, _body, who) => {
  if (!isTherapist(who)) return fail(403, 'Only therapists can see the patient list.');
  return ok(db.listPatientSummaries());
});

route('GET', /^\/users\/(\d+)$/, ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  const user = db.getUser(Number(id));
  return user ? ok(db.publicUser(user)) : fail(404, 'User not found');
});

route('GET', /^\/exercises$/, () =>
  ok(db.listExercises().map((e) => ({ key: e.key, name: e.name, priority: null, starting_tolerance: null })))
);

route('GET', /^\/users\/(\d+)\/exercises$/, ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  if (!db.getUser(Number(id))) return fail(404, 'User not found');
  const names = Object.fromEntries(db.listExercises().map((e) => [e.key, e.name]));
  return ok(
    db.getRecommendedExercises(Number(id)).map((r) => ({
      key: r.exercise_key,
      name: names[r.exercise_key] || r.exercise_key,
      priority: r.priority,
      starting_tolerance: r.starting_tolerance,
      reps_per_set: r.reps_per_set,
      custom: r.custom,
    }))
  );
});

// ---------------------------------------------------------------
// Set recordings (video of a patient's set, if they agreed to it)
// ---------------------------------------------------------------
// The patient's own choice. Only they can change it, and turning it off
// immediately stops their therapist from watching anything.
route('PUT', /^\/users\/(\d+)\/recording-consent$/, ([id], body, who) => {
  if (who.sub !== Number(id)) return fail(403, 'Not allowed.');
  if (typeof body?.share_recordings !== 'boolean') return fail(400, 'Please say yes or no.');
  db.setShareRecordings(who.sub, body.share_recordings);
  return ok({ share_recordings: body.share_recordings });
});

// The patient's page uploads the video right after saving the session.
route('POST', /^\/sessions\/(\d+)\/recording$/, ([id], body, who) => {
  const session = db.getSession(Number(id));
  if (!session || session.user_id !== who.sub) return fail(404, 'Session not found.');
  const owner = db.getUser(who.sub);
  if (!owner.share_recordings) return fail(403, 'Recordings are switched off for this account.');
  if (session.has_recording) return fail(409, 'This session already has a recording.');
  const decoded = recordings.decodeUpload(body?.data);
  if (decoded.error) return fail(400, decoded.error);
  recordings.saveRecording(session.id, decoded.buf);
  db.setHasRecording(session.id, true);
  return ok({ saved: true });
});

// The patient can watch their own; a therapist can watch a patient's only
// while that patient still allows it.
route('GET', /^\/sessions\/(\d+)\/recording$/, ([id], _body, who) => {
  const session = db.getSession(Number(id));
  if (!session || !session.has_recording) return fail(404, 'No recording for this session.');
  const mine = session.user_id === who.sub;
  if (!mine) {
    // Another patient gets the same answer as "no such recording".
    if (!isTherapist(who)) return fail(404, 'No recording for this session.');
    if (!db.getUser(session.user_id)?.share_recordings) {
      return fail(403, 'This patient has not allowed recordings to be watched.');
    }
  }
  const buf = recordings.readRecording(session.id);
  if (!buf) return fail(404, 'No recording for this session.');
  return ok({ mime: 'video/webm', data: buf.toString('base64') });
});

// ---------------------------------------------------------------
// Therapist: notes and exercise plans for a patient
// ---------------------------------------------------------------
// Therapist-only routes below start with this check. Returns an error
// response to send back, or null when the caller may continue.
function therapistOnPatient(who, patientId) {
  if (!isTherapist(who)) return fail(403, 'Only therapists can do this.');
  const patient = db.getUser(patientId);
  if (!patient || patient.role !== 'patient') return fail(404, 'Patient not found.');
  return null;
}

route('POST', /^\/patients\/(\d+)\/notes$/, ([id], body, who) => {
  const denied = therapistOnPatient(who, Number(id));
  if (denied) return denied;
  const text = String(body?.body ?? '').trim();
  if (!text) return fail(400, 'Please write a note first.');
  if (text.length > db.NOTE_MAX_LEN) return fail(400, `Notes can be at most ${db.NOTE_MAX_LEN} characters.`);
  return ok(db.publicNote(db.addNote(Number(id), who.sub, text)));
});

// A patient reads their own notes; a therapist can read any patient's.
route('GET', /^\/users\/(\d+)\/notes$/, ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  if (!db.getUser(Number(id))) return fail(404, 'User not found');
  return ok(db.listNotes(Number(id)).map(db.publicNote));
});

route('DELETE', /^\/notes\/(\d+)$/, ([id], _body, who) => {
  if (!isTherapist(who)) return fail(403, 'Only therapists can do this.');
  // Only the author can delete; anyone else gets the same answer as a missing note.
  return db.deleteNote(Number(id), who.sub) ? ok({ deleted: true }) : fail(404, 'Note not found.');
});

// The plan editor's starting point: every exercise, with whether it is in the
// patient's plan. If no custom plan exists yet, the patient's default plan
// (from their conditions) is pre-ticked.
route('GET', /^\/patients\/(\d+)\/plan$/, ([id], _body, who) => {
  const denied = therapistOnPatient(who, Number(id));
  if (denied) return denied;
  const current = db.getRecommendedExercises(Number(id));
  const byKey = new Map(current.map((r) => [r.exercise_key, r]));
  return ok({
    custom: current.some((r) => r.custom),
    min_reps: db.PLAN_MIN_REPS,
    max_reps: db.PLAN_MAX_REPS,
    default_reps: DEFAULT_SET_REPS,
    exercises: db.listExercises().map((e) => ({
      key: e.key,
      name: e.name,
      enabled: byKey.has(e.key),
      reps_per_set: byKey.get(e.key)?.reps_per_set ?? DEFAULT_SET_REPS,
    })),
  });
});

route('PUT', /^\/patients\/(\d+)\/plan$/, ([id], body, who) => {
  const denied = therapistOnPatient(who, Number(id));
  if (denied) return denied;
  const items = body?.exercises;
  if (!Array.isArray(items) || !items.length) return fail(400, 'Choose at least one exercise.');
  const valid = new Set(db.listExercises().map((e) => e.key));
  const seen = new Set();
  for (const it of items) {
    if (!valid.has(it?.key)) return fail(400, `Unknown exercise: ${it?.key}`);
    if (seen.has(it.key)) return fail(400, `Exercise listed twice: ${it.key}`);
    seen.add(it.key);
    const r = it.reps_per_set;
    if (!Number.isInteger(r) || r < db.PLAN_MIN_REPS || r > db.PLAN_MAX_REPS) {
      return fail(400, `Reps per set must be a whole number from ${db.PLAN_MIN_REPS} to ${db.PLAN_MAX_REPS}.`);
    }
  }
  db.setPlan(Number(id), who.sub, items.map((it) => ({ key: it.key, reps_per_set: it.reps_per_set })));
  return ok({ saved: true });
});

// Back to the default plan from the patient's conditions.
route('DELETE', /^\/patients\/(\d+)\/plan$/, ([id], _body, who) => {
  const denied = therapistOnPatient(who, Number(id));
  if (denied) return denied;
  db.clearPlan(Number(id));
  return ok({ reset: true });
});

route('POST', /^\/sessions$/, (_p, body, who) => {
  const b = body || {};
  const ints = ['user_id', 'reps', 'score', 'max_streak', 'level'];
  const valid =
    ints.every((k) => Number.isFinite(Number(b[k]))) &&
    Number.isFinite(Number(b.accuracy)) &&
    typeof b.exercise_key === 'string';
  if (!valid) return fail(422, 'Invalid session data.');
  // Sessions are saved only to the signed-in user's own record.
  if (Number(b.user_id) !== who.sub) return fail(403, 'Not allowed.');
  if (!db.getUser(Number(b.user_id))) return fail(404, 'User not found');
  if (!db.listSessionKeys().includes(b.exercise_key)) {
    return fail(400, `Unknown exercise_key: ${b.exercise_key}`);
  }
  const entry = db.logSession(
    Number(b.user_id), b.exercise_key, Math.round(b.reps), Math.round(b.score),
    Number(b.accuracy), Math.round(b.max_streak), Math.round(b.level), b.form_faults
  );
  return ok(db.publicSession(entry));
});

route('GET', /^\/users\/(\d+)\/sessions$/, ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  if (!db.getUser(Number(id))) return fail(404, 'User not found');
  return ok(db.getHistory(Number(id)).map(db.publicSession));
});

function handleRequest(method, path, body, token) {
  const cleanPath = String(path).split('?')[0];
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(cleanPath);
    if (!m) continue;
    try {
      let who = null;
      if (!r.isPublic) {
        who = auth.verifyToken(token);
        if (!who) return fail(401, 'Please log in again.');
        // The account must still exist, and its role is whatever the database
        // says now, not whatever an older token claimed.
        const current = db.getUser(who.sub);
        if (!current) return fail(401, 'Please log in again.');
        who = { sub: current.id, role: current.role };
      }
      return r.handler(m.slice(1), body, who);
    } catch (err) {
      console.error('[armup] route error:', method, cleanPath, err);
      return fail(500, 'Something went wrong on our side.');
    }
  }
  return fail(404, 'Not found');
}

module.exports = { handleRequest };
