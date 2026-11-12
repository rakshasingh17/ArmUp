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

const MIN_PASSWORD_LEN = 6; // keep in sync with SignupPage.jsx

const ok = (body) => ({ status: 200, body });
const fail = (status, detail) => ({ status, body: { detail } });

// A route is public unless declared otherwise. Protected handlers receive the
// verified token claims as `who` ({ sub, role }); the user id always comes
// from the token, never from anything the page sends.
const routes = [];
const route = (method, pattern, handler, { public: isPublic = false } = {}) =>
  routes.push({ method, pattern, handler, isPublic });

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
    }))
  );
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
  if (!db.listExercises().some((e) => e.key === b.exercise_key)) {
    return fail(400, `Unknown exercise_key: ${b.exercise_key}`);
  }
  const entry = db.logSession(
    Number(b.user_id), b.exercise_key, Math.round(b.reps), Math.round(b.score),
    Number(b.accuracy), Math.round(b.max_streak), Math.round(b.level)
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
