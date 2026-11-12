/*
 * routes.cjs -- Node port of backend/armup_api.py
 * -----------------------------------------------
 * Same paths, same validation messages, same JSON shapes as the FastAPI
 * version, so the React pages don't care what is behind them.
 *
 * handleRequest(method, path, body) -> { status, body }
 * No HTTP server involved: main.cjs calls this through Electron IPC.
 * (The dead POST /start-session route is intentionally not ported.)
 */
const db = require('./db.cjs');

const MIN_PASSWORD_LEN = 6; // keep in sync with SignupPage.jsx

const ok = (body) => ({ status: 200, body });
const fail = (status, detail) => ({ status, body: { detail } });

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/$/, () => ok({ status: 'ok', service: 'armup' }));

route('GET', /^\/conditions$/, () => ok(db.listConditions()));

route('POST', /^\/users$/, (_p, body) => {
  const name = String(body?.name ?? '').trim();
  const password = String(body?.password ?? '');
  if (!name) return fail(400, 'Please enter your name.');
  if (password.length < MIN_PASSWORD_LEN) {
    return fail(400, `Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  const tags = [...new Set(Array.isArray(body?.ailment_tags) ? body.ailment_tags : [])];
  if (!tags.length) return fail(400, 'Select at least one condition.');
  const valid = new Set(db.listConditions().map((c) => c.tag));
  const unknown = tags.find((t) => !valid.has(t));
  if (unknown) return fail(400, `Unknown condition: ${unknown}`);
  if (db.getUserByName(name)) {
    return fail(409, "That name is already taken. Choose another, or log in if it's yours.");
  }
  return ok(db.publicUser(db.createUser(name, tags, password)));
});

route('POST', /^\/login$/, (_p, body) => {
  const user = db.authenticate(String(body?.name ?? ''), String(body?.password ?? ''));
  // Same message for "no such name" and "wrong password" on purpose.
  return user ? ok(db.publicUser(user)) : fail(401, 'Incorrect name or password.');
});

route('GET', /^\/users\/(\d+)$/, ([id]) => {
  const user = db.getUser(Number(id));
  return user ? ok(db.publicUser(user)) : fail(404, 'User not found');
});

route('GET', /^\/exercises$/, () =>
  ok(db.listExercises().map((e) => ({ key: e.key, name: e.name, priority: null, starting_tolerance: null })))
);

route('GET', /^\/users\/(\d+)\/exercises$/, ([id]) => {
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

route('POST', /^\/sessions$/, (_p, body) => {
  const b = body || {};
  const ints = ['user_id', 'reps', 'score', 'max_streak', 'level'];
  const valid =
    ints.every((k) => Number.isFinite(Number(b[k]))) &&
    Number.isFinite(Number(b.accuracy)) &&
    typeof b.exercise_key === 'string';
  if (!valid) return fail(422, 'Invalid session data.');
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

route('GET', /^\/users\/(\d+)\/sessions$/, ([id]) => {
  if (!db.getUser(Number(id))) return fail(404, 'User not found');
  return ok(db.getHistory(Number(id)).map(db.publicSession));
});

function handleRequest(method, path, body) {
  const cleanPath = String(path).split('?')[0];
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(cleanPath);
    if (m) {
      try {
        return r.handler(m.slice(1), body);
      } catch (err) {
        console.error('[armup] route error:', method, cleanPath, err);
        return fail(500, 'Something went wrong on our side.');
      }
    }
  }
  return fail(404, 'Not found');
}

module.exports = { handleRequest };
