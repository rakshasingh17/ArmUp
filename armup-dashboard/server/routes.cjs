/*
 * routes.cjs -- the ArmUp API (online version)
 * --------------------------------------------
 * Same paths, same validation messages and same JSON shapes as the desktop
 * version (electron/routes.cjs), so the React pages don't care what is behind
 * them. The differences are all about being on the internet:
 *   - every database call is awaited
 *   - wrong passwords and wrong invite codes are rate-limited
 *   - /demo-login only works when the server is started with ENABLE_DEMO=1
 *   - set recordings are switched off (the server's disk is not permanent)
 *
 * handleRequest(method, path, body, token, ctx) -> { status, body }
 * ctx = { ip } is only used for the rate limits.
 */
const db = require('./db.cjs');
const auth = require('./auth.cjs');
const appts = require('./appointments.cjs');
const { createLimiter } = require('./ratelimit.cjs');

const MIN_PASSWORD_LEN = 6; // keep in sync with SignupPage.jsx
const FIFTEEN_MIN = 15 * 60 * 1000;

const settings = {
  demoLogin: false,
  now: () => Date.now(),
};
// Failed-attempt limits. Per name stops guessing one account's password; per
// address is a looser net for someone trying many names.
let nameLimiter, ipLimiter, inviteLimiter;
function resetLimits() {
  const now = () => settings.now();
  nameLimiter = createLimiter({ max: 8, windowMs: FIFTEEN_MIN, now });
  ipLimiter = createLimiter({ max: 40, windowMs: FIFTEEN_MIN, now });
  inviteLimiter = createLimiter({ max: 10, windowMs: FIFTEEN_MIN, now });
}
resetLimits();

function configure(options = {}) {
  if (options.demoLogin !== undefined) settings.demoLogin = !!options.demoLogin;
  if (options.now) settings.now = options.now;
  resetLimits();
}

const ok = (body) => ({ status: 200, body });
const fail = (status, detail) => ({ status, body: { detail } });
const tooMany = (seconds) => ({
  status: 429,
  body: { detail: `Too many tries. Please wait ${Math.ceil(seconds / 60)} minute(s) and try again.` },
  retryAfter: seconds,
});

// One-at-a-time queue, so two people booking the same slot at the same moment
// can't both get it (check + save happen together). Fine for one server instance.
let apptQueue = Promise.resolve();
function exclusively(fn) {
  const run = apptQueue.then(fn, fn);
  apptQueue = run.catch(() => {});
  return run;
}

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

const NAME_TAKEN = "That name is already taken. Choose another, or log in if it's yours.";
const isDuplicate = (err) => err && err.code === '23505'; // Postgres "unique violation"

route('GET', /^\/$/, () => ok({ status: 'ok', service: 'armup' }), { public: true });

route('GET', /^\/conditions$/, async () => ok(await db.listConditions()), { public: true });

route('POST', /^\/users$/, async (_p, body, _who, ctx) => {
  const name = String(body?.name ?? '').trim();
  const password = String(body?.password ?? '');
  const role = body?.role === undefined ? 'patient' : body.role;
  if (!db.ROLES.includes(role)) return fail(400, 'Unknown role.');
  if (!name) return fail(400, 'Please enter your name.');
  if (name.length > 100) return fail(400, 'That name is too long.');
  if (password.length < MIN_PASSWORD_LEN) {
    return fail(400, `Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  if (password.length > 200) return fail(400, 'That password is too long.');
  if (await db.getUserByName(name)) return fail(409, NAME_TAKEN);

  try {
    if (role === 'therapist') {
      // Therapist accounts need a single-use invite code, checked here (not in
      // the page) so it can't be skipped by editing the UI.
      const key = ctx.ip;
      const wait = inviteLimiter.blockedFor(key);
      if (wait) return tooMany(wait);
      const therapist = await db.createTherapistWithInvite(name, password, String(body?.invite_code ?? ''));
      if (!therapist) {
        inviteLimiter.fail(key);
        return fail(403, "That invite code isn't valid or has already been used.");
      }
      return ok(withToken(therapist));
    }

    const tags = [...new Set(Array.isArray(body?.ailment_tags) ? body.ailment_tags : [])];
    if (!tags.length) return fail(400, 'Select at least one condition.');
    const valid = new Set((await db.listConditions()).map((c) => c.tag));
    const unknown = tags.find((t) => !valid.has(t));
    if (unknown) return fail(400, `Unknown condition: ${String(unknown).slice(0, 60)}`);
    return ok(withToken(await db.createUser(name, tags, password, 'patient')));
  } catch (err) {
    if (isDuplicate(err)) return fail(409, NAME_TAKEN); // two sign-ups with one name at once
    throw err;
  }
}, { public: true });

route('POST', /^\/login$/, async (_p, body, _who, ctx) => {
  const name = String(body?.name ?? '');
  const nameKey = `n:${name.trim().toLowerCase()}`;
  const ipKey = `i:${ctx.ip}`;
  const wait = Math.max(nameLimiter.blockedFor(nameKey), ipLimiter.blockedFor(ipKey));
  if (wait) return tooMany(wait);

  const user = await db.authenticate(name, String(body?.password ?? ''));
  if (!user) {
    nameLimiter.fail(nameKey);
    ipLimiter.fail(ipKey);
    // Same message for "no such name" and "wrong password" on purpose.
    return fail(401, 'Incorrect name or password.');
  }
  nameLimiter.clear(nameKey);
  return ok(withToken(user));
}, { public: true });

// "Continue as test patient" on the landing page. Only ever signs in the
// seeded "Demo Patient" account, and only when the server turned it on.
route('POST', /^\/demo-login$/, async () => {
  if (!settings.demoLogin) return fail(404, 'Not found');
  const user = await db.getUserByName('Demo Patient');
  return user && user.role === 'patient' ? ok(withToken(user)) : fail(404, 'Demo account not found.');
}, { public: true });

// Therapists can invite other therapists. Patients get 403.
route('POST', /^\/invites$/, async (_p, _body, who) => {
  if (!isTherapist(who)) return fail(403, 'Only therapists can create invite codes.');
  return ok({ code: await db.createInviteCode(who.sub) });
});

// The therapist's patient list. Patients get 403.
route('GET', /^\/patients$/, async (_p, _body, who) => {
  if (!isTherapist(who)) return fail(403, 'Only therapists can see the patient list.');
  return ok(await db.listPatientSummaries());
});

route('GET', /^\/users\/(\d+)$/, async ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  const user = await db.getUser(Number(id));
  return user ? ok(db.publicUser(user)) : fail(404, 'User not found');
});

route('GET', /^\/exercises$/, async () =>
  ok((await db.listExercises()).map((e) => ({ key: e.key, name: e.name, priority: null, starting_tolerance: null })))
);

route('GET', /^\/users\/(\d+)\/exercises$/, async ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  if (!(await db.getUser(Number(id)))) return fail(404, 'User not found');
  const names = Object.fromEntries((await db.listExercises()).map((e) => [e.key, e.name]));
  return ok(
    (await db.getRecommendedExercises(Number(id))).map((r) => ({
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
// Set recordings. Switched OFF in the online version: the server's disk is
// wiped on restart and videos of patients are the most sensitive data there
// is, so they are simply not accepted. The consent choice still works.
// ---------------------------------------------------------------
route('PUT', /^\/users\/(\d+)\/recording-consent$/, async ([id], body, who) => {
  if (who.sub !== Number(id)) return fail(403, 'Not allowed.');
  if (typeof body?.share_recordings !== 'boolean') return fail(400, 'Please say yes or no.');
  await db.setShareRecordings(who.sub, body.share_recordings);
  return ok({ share_recordings: body.share_recordings });
});

route('POST', /^\/sessions\/(\d+)\/recording$/, () =>
  fail(403, 'Set recordings are turned off in the online version.'));

route('GET', /^\/sessions\/(\d+)\/recording$/, () => fail(404, 'No recording for this session.'));

// ---------------------------------------------------------------
// Therapist: notes and exercise plans for a patient
// ---------------------------------------------------------------
// Therapist-only routes below start with this check. Returns an error
// response to send back, or null when the caller may continue.
async function therapistOnPatient(who, patientId) {
  if (!isTherapist(who)) return fail(403, 'Only therapists can do this.');
  const patient = await db.getUser(patientId);
  if (!patient || patient.role !== 'patient') return fail(404, 'Patient not found.');
  return null;
}

route('POST', /^\/patients\/(\d+)\/notes$/, async ([id], body, who) => {
  const denied = await therapistOnPatient(who, Number(id));
  if (denied) return denied;
  const text = String(body?.body ?? '').trim();
  if (!text) return fail(400, 'Please write a note first.');
  if (text.length > db.NOTE_MAX_LEN) return fail(400, `Notes can be at most ${db.NOTE_MAX_LEN} characters.`);
  return ok(db.publicNote(await db.addNote(Number(id), who.sub, text)));
});

// A patient reads their own notes; a therapist can read any patient's.
route('GET', /^\/users\/(\d+)\/notes$/, async ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  if (!(await db.getUser(Number(id)))) return fail(404, 'User not found');
  return ok((await db.listNotes(Number(id))).map(db.publicNote));
});

route('DELETE', /^\/notes\/(\d+)$/, async ([id], _body, who) => {
  if (!isTherapist(who)) return fail(403, 'Only therapists can do this.');
  // Only the author can delete; anyone else gets the same answer as a missing note.
  return (await db.deleteNote(Number(id), who.sub)) ? ok({ deleted: true }) : fail(404, 'Note not found.');
});

// ---------------------------------------------------------------
// Appointments. A therapist books one for a patient (the patient confirms),
// or a patient requests one with a therapist (the therapist approves).
// The rules for who may do what are in appointments.cjs.
// ---------------------------------------------------------------
// Therapists' names, for the patient's "request an appointment" picker.
route('GET', /^\/therapists$/, async () => ok(await db.listTherapists()));

// Your own appointments: a therapist's, or a patient's.
route('GET', /^\/appointments$/, async (_p, _body, who) =>
  ok((await db.listAppointments(who.role, who.sub)).map(db.publicAppointment)));

// Checks a start time and length against both people's calendars.
// Returns an error response, or null when the slot is free.
async function slotProblem(therapistId, patientId, startsAt, minutes, excludeId = 0) {
  if (await db.hasBookedOverlap('therapist_id', therapistId, startsAt, minutes, excludeId)) {
    return fail(409, 'That time is already taken. Please choose another.');
  }
  if (await db.hasBookedOverlap('patient_id', patientId, startsAt, minutes, excludeId)) {
    return fail(409, 'There is already an appointment at that time.');
  }
  return null;
}

route('POST', /^\/appointments$/, async (_p, body, who) => {
  const start = appts.parseStart(body?.starts_at);
  if (start.error) return fail(400, start.error);
  const minutes = appts.cleanDuration(body?.duration_min);
  if (minutes === null) return fail(400, `Length must be one of: ${appts.DURATIONS.join(', ')} minutes.`);
  const note = appts.cleanNote(body?.note);
  if (note.error) return fail(400, note.error);

  let patientId, therapistId, status;
  if (isTherapist(who)) {
    patientId = Number(body?.patient_id);
    const denied = await therapistOnPatient(who, patientId);
    if (denied) return denied;
    therapistId = who.sub;
    status = 'scheduled'; // waits for the patient to confirm
  } else {
    therapistId = Number(body?.therapist_id);
    if ((await db.getUser(therapistId))?.role !== 'therapist') return fail(404, 'Therapist not found.');
    patientId = who.sub;
    status = 'requested'; // waits for the therapist to approve
  }
  return exclusively(async () => {
    const problem = await slotProblem(therapistId, patientId, start.date, minutes);
    if (problem) return problem;
    const created = await db.createAppointment({
      patientId, therapistId, startsAt: start.date, durationMin: minutes, note: note.note,
      status, requestedBy: isTherapist(who) ? 'therapist' : 'patient',
    });
    return ok(db.publicAppointment(created));
  });
});

route('POST', /^\/appointments\/(\d+)\/(confirm|cancel|decline|approve|complete|reschedule)$/, ([id, action], body, who) =>
  exclusively(async () => {
    const appt = await db.getAppointment(Number(id));
    // Someone else's appointment looks the same as one that doesn't exist.
    const mine = appt && (isTherapist(who) ? appt.therapist_id === who.sub : appt.patient_id === who.sub);
    if (!mine) return fail(404, 'Appointment not found.');
    const next = appts.nextStatus(who.role, appt.status, action);
    if (!next) return fail(409, "That can't be done to this appointment.");

    const current = db.publicAppointment(appt);
    let startsAt;
    if (action === 'reschedule') {
      const start = appts.parseStart(body?.starts_at);
      if (start.error) return fail(400, start.error);
      startsAt = start.date;
    }
    if (action === 'approve' || action === 'reschedule') {
      const problem = await slotProblem(appt.therapist_id, appt.patient_id,
        startsAt || new Date(current.starts_at), appt.duration_min, appt.id);
      if (problem) return problem;
    }
    if (action === 'complete' && new Date(current.starts_at) > new Date()) {
      return fail(409, "This appointment hasn't started yet.");
    }
    const updated = await db.updateAppointment(appt.id, {
      status: next, startsAt,
      requestedBy: action === 'reschedule' ? who.role : undefined,
    });
    return ok(db.publicAppointment(updated));
  }));

// The plan editor's starting point: every exercise, with whether it is in the
// patient's plan. If no custom plan exists yet, the patient's default plan
// (from their conditions) is pre-ticked.
route('GET', /^\/patients\/(\d+)\/plan$/, async ([id], _body, who) => {
  const denied = await therapistOnPatient(who, Number(id));
  if (denied) return denied;
  const current = await db.getRecommendedExercises(Number(id));
  const byKey = new Map(current.map((r) => [r.exercise_key, r]));
  return ok({
    custom: current.some((r) => r.custom),
    min_reps: db.PLAN_MIN_REPS,
    max_reps: db.PLAN_MAX_REPS,
    default_reps: DEFAULT_SET_REPS,
    exercises: (await db.listExercises()).map((e) => ({
      key: e.key,
      name: e.name,
      enabled: byKey.has(e.key),
      reps_per_set: byKey.get(e.key)?.reps_per_set ?? DEFAULT_SET_REPS,
    })),
  });
});

route('PUT', /^\/patients\/(\d+)\/plan$/, async ([id], body, who) => {
  const denied = await therapistOnPatient(who, Number(id));
  if (denied) return denied;
  const items = body?.exercises;
  if (!Array.isArray(items) || !items.length) return fail(400, 'Choose at least one exercise.');
  const valid = new Set((await db.listExercises()).map((e) => e.key));
  const seen = new Set();
  for (const it of items) {
    if (!valid.has(it?.key)) return fail(400, `Unknown exercise: ${String(it?.key).slice(0, 60)}`);
    if (seen.has(it.key)) return fail(400, `Exercise listed twice: ${it.key}`);
    seen.add(it.key);
    const r = it.reps_per_set;
    if (!Number.isInteger(r) || r < db.PLAN_MIN_REPS || r > db.PLAN_MAX_REPS) {
      return fail(400, `Reps per set must be a whole number from ${db.PLAN_MIN_REPS} to ${db.PLAN_MAX_REPS}.`);
    }
  }
  await db.setPlan(Number(id), who.sub, items.map((it) => ({ key: it.key, reps_per_set: it.reps_per_set })));
  return ok({ saved: true });
});

// Back to the default plan from the patient's conditions.
route('DELETE', /^\/patients\/(\d+)\/plan$/, async ([id], _body, who) => {
  const denied = await therapistOnPatient(who, Number(id));
  if (denied) return denied;
  await db.clearPlan(Number(id));
  return ok({ reset: true });
});

// A saved session's numbers must fit the database's whole-number columns.
const SESSION_NUMBER_MAX = 1_000_000;

route('POST', /^\/sessions$/, async (_p, body, who) => {
  const b = body || {};
  const ints = ['user_id', 'reps', 'score', 'max_streak', 'level'];
  const valid =
    ints.every((k) => Number.isFinite(Number(b[k]))) &&
    Number.isFinite(Number(b.accuracy)) &&
    typeof b.exercise_key === 'string';
  if (!valid) return fail(422, 'Invalid session data.');
  // Sessions are saved only to the signed-in user's own record.
  if (Number(b.user_id) !== who.sub) return fail(403, 'Not allowed.');
  if (!(await db.getUser(Number(b.user_id)))) return fail(404, 'User not found');
  if (!(await db.listSessionKeys()).includes(b.exercise_key)) {
    return fail(400, `Unknown exercise_key: ${b.exercise_key.slice(0, 60)}`);
  }
  const counts = ['reps', 'score', 'max_streak', 'level'].map((k) => Math.round(Number(b[k])));
  if (counts.some((n) => n < 0 || n > SESSION_NUMBER_MAX) || Math.abs(Number(b.accuracy)) > SESSION_NUMBER_MAX) {
    return fail(422, 'Invalid session data.');
  }
  const [reps, score, maxStreak, level] = counts;
  const entry = await db.logSession(
    Number(b.user_id), b.exercise_key, reps, score, Number(b.accuracy), maxStreak, level, b.form_faults
  );
  return ok(db.publicSession(entry));
});

route('GET', /^\/users\/(\d+)\/sessions$/, async ([id], _body, who) => {
  if (!canReadUser(who, Number(id))) return fail(403, 'Not allowed.');
  if (!(await db.getUser(Number(id)))) return fail(404, 'User not found');
  return ok((await db.getHistory(Number(id))).map(db.publicSession));
});

async function handleRequest(method, path, body, token, ctx = {}) {
  const cleanPath = String(path).split('?')[0];
  const context = { ip: ctx.ip || 'unknown' };
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
        const current = await db.getUser(who.sub);
        if (!current) return fail(401, 'Please log in again.');
        who = { sub: current.id, role: current.role };
      }
      return await r.handler(m.slice(1), body, who, context);
    } catch (err) {
      console.error('[armup] route error:', method, cleanPath, err);
      return fail(500, 'Something went wrong on our side.');
    }
  }
  return fail(404, 'Not found');
}

module.exports = { handleRequest, configure };
