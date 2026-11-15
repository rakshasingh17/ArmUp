/*
 * db.cjs -- PostgreSQL version of electron/db.cjs
 * -----------------------------------------------
 * Same functions and same rules as the SQLite version, but every call that
 * touches the database is now async (await it) and goes to one shared
 * PostgreSQL database (Neon). Password-hash format is unchanged
 * ("salt_hex$digest_hex", PBKDF2-SHA256, 200,000 rounds).
 *
 * All queries use $1, $2 ... placeholders. Nothing from a user is ever glued
 * into SQL text, which is what stops SQL injection.
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const appointmentRules = require('./appointments.cjs');

const pbkdf2 = promisify(crypto.pbkdf2);
const PBKDF2_ROUNDS = 200_000;

const SEED_EXERCISES = [
  ['curl', 'Bicep Curl'],
  ['raise', 'Lateral Raise'],
  ['press', 'Shoulder Press'],
  ['neck_tilt', 'Owl Neck Tilt'],
];

// Games record sessions like exercises do, but are not rep-counted exercises:
// they never appear in the therapist's plan editor (see listExercises).
const GAME_KEYS = ['koi'];
const SEED_GAMES = [['koi', 'Koi Chase']];

// (ailment_tag, exercise_key, starting_tolerance, priority)
const SEED_AILMENT_MAP = [
  ['frozen_shoulder', 'raise', 20.0, 1],
  ['frozen_shoulder', 'press', 20.0, 2],
  ['cervical_spondylosis', 'neck_tilt', 10.0, 1],
  ['neck_stiffness', 'neck_tilt', 10.0, 1],
  ['post_stroke_upper_limb', 'curl', 22.0, 1],
  ['post_stroke_upper_limb', 'raise', 22.0, 2],
  ['desk_posture', 'neck_tilt', 10.0, 1],
  ['desk_posture', 'raise', 15.0, 2],
];

const CONDITION_LABELS = {
  frozen_shoulder: 'Frozen shoulder',
  cervical_spondylosis: 'Cervical spondylosis',
  neck_stiffness: 'Neck stiffness',
  post_stroke_upper_limb: 'Post-stroke arm weakness',
  desk_posture: 'Desk posture strain',
};

const ROLES = ['patient', 'therapist'];
const FORM_FAULT_IDS = ['elbow_drift', 'too_high', 'lean_back'];
const PLAN_MIN_REPS = 3;
const PLAN_MAX_REPS = 30;
const NOTE_MAX_LEN = 1000;
const MAX_ID = 2147483647; // largest value of a Postgres INTEGER id

let pool = null;

const query = (text, params) => pool.query(text, params);
const rows = async (text, params) => (await query(text, params)).rows;
const first = async (text, params) => (await query(text, params)).rows[0];
const validId = (n) => Number.isInteger(n) && n > 0 && n <= MAX_ID;

// Runs fn(client) in one transaction: all of it happens, or none of it.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------
// Open + schema
// ---------------------------------------------------------------
// options.inviteCodes: therapist sign-up codes to make sure exist (from the
//   INVITE_CODES environment variable). None are built into the code.
// options.seedDemoPatient: also create the "Demo Patient" account.
async function openDb(connectionString, options = {}) {
  const { inviteCodes = [], seedDemoPatient = false, ssl } = options;
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000, // a sleeping Neon database can take a few seconds to wake
    ...(ssl === undefined ? {} : { ssl }),
  });
  // An idle connection that dies (Neon suspends when idle) must not crash the server.
  pool.on('error', (err) => console.error('[armup] idle database connection error:', err.message));
  await initSchema();
  await seedAll({ inviteCodes, seedDemoPatient });
  return pool;
}

async function closeDb() {
  if (pool) await pool.end();
  pool = null;
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR NOT NULL,
      ailment_tags VARCHAR DEFAULT '',
      password_hash VARCHAR,
      role VARCHAR NOT NULL DEFAULT 'patient',
      -- true = the patient agreed that their therapist may watch recordings of their sets
      share_recordings BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name));
    CREATE TABLE IF NOT EXISTS exercises (
      key VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      exercise_key VARCHAR NOT NULL REFERENCES exercises(key),
      timestamp TIMESTAMPTZ,
      reps INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      accuracy DOUBLE PRECISION DEFAULT 0.0,
      max_streak INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      form_faults TEXT,
      has_recording BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS session_logs_user_idx ON session_logs (user_id);
    CREATE TABLE IF NOT EXISTS ailment_exercise_map (
      id SERIAL PRIMARY KEY,
      ailment_tag VARCHAR NOT NULL,
      exercise_key VARCHAR NOT NULL REFERENCES exercises(key),
      starting_tolerance DOUBLE PRECISION,
      priority INTEGER DEFAULT 1
    );
    -- A therapist's custom exercise plan for one patient. No rows = the patient
    -- uses the default plan that comes from their conditions.
    CREATE TABLE IF NOT EXISTS patient_plan (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      exercise_key VARCHAR NOT NULL,
      reps_per_set INTEGER NOT NULL,
      position INTEGER NOT NULL,
      set_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMPTZ,
      UNIQUE (user_id, exercise_key)
    );
    -- Notes a therapist leaves for a patient.
    CREATE TABLE IF NOT EXISTS therapist_notes (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      therapist_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ
    );
    -- Appointments between a patient and a therapist.
    -- requested_by says who proposed the current time ('patient' or 'therapist').
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      therapist_id INTEGER NOT NULL REFERENCES users(id),
      starts_at TIMESTAMPTZ NOT NULL,
      duration_min INTEGER NOT NULL DEFAULT 30,
      note TEXT NOT NULL DEFAULT '',
      status VARCHAR NOT NULL,
      requested_by VARCHAR NOT NULL,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS appointments_patient_idx ON appointments (patient_id);
    CREATE INDEX IF NOT EXISTS appointments_therapist_idx ON appointments (therapist_id);
    -- Single-use therapist invite codes. Only a hash of each code is stored.
    CREATE TABLE IF NOT EXISTS invite_codes (
      id SERIAL PRIMARY KEY,
      code_hash VARCHAR NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ,
      used_by INTEGER REFERENCES users(id),
      used_at TIMESTAMPTZ
    );
  `);
}

async function seedAll({ inviteCodes, seedDemoPatient }) {
  await transaction(async (c) => {
    // One server at a time may seed (a second one waits here, then finds it done).
    await c.query('SELECT pg_advisory_xact_lock(8472001)');
    for (const [key, name] of [...SEED_EXERCISES, ...SEED_GAMES]) {
      await c.query('INSERT INTO exercises (key, name) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, name]);
    }
    const mapped = await c.query('SELECT 1 FROM ailment_exercise_map LIMIT 1');
    if (!mapped.rowCount) {
      for (const r of SEED_AILMENT_MAP) {
        await c.query(
          'INSERT INTO ailment_exercise_map (ailment_tag, exercise_key, starting_tolerance, priority) VALUES ($1, $2, $3, $4)', r);
      }
    }
    // Invite codes from the environment. A code that already exists (even a
    // used one) is left alone, so restarting never makes a used code usable.
    for (const code of inviteCodes) {
      await c.query(
        'INSERT INTO invite_codes (code_hash, created_at) VALUES ($1, now()) ON CONFLICT (code_hash) DO NOTHING',
        [hashInvite(code)]);
    }
  });
  if (seedDemoPatient && !(await getUserByName('Demo Patient'))) {
    try {
      await createUser('Demo Patient', ['neck_stiffness'], 'demo1234');
    } catch (err) {
      if (err.code !== '23505') throw err; // another start-up created it first
    }
  }
}

// ---------------------------------------------------------------
// Passwords (async, so hashing never freezes the server)
// ---------------------------------------------------------------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = await pbkdf2(password, salt, PBKDF2_ROUNDS, 32, 'sha256');
  return `${salt.toString('hex')}$${digest.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 2) return false;
  try {
    const salt = Buffer.from(parts[0], 'hex');
    const expected = Buffer.from(parts[1], 'hex');
    if (!expected.length) return false;
    const digest = await pbkdf2(password, salt, PBKDF2_ROUNDS, expected.length, 'sha256');
    return crypto.timingSafeEqual(digest, expected);
  } catch {
    return false;
  }
}

// Timestamps come back from Postgres as Date objects; the pages get ISO text.
const iso = (v) => (v ? new Date(v).toISOString() : v);

// ---------------------------------------------------------------
// Users
// ---------------------------------------------------------------
const tagsOf = (user) => (user.ailment_tags || '').split(',').filter(Boolean);

function publicUser(user) {
  return {
    id: user.id, name: user.name, ailment_tags: tagsOf(user), role: user.role,
    share_recordings: !!user.share_recordings,
  };
}

async function setShareRecordings(userId, allowed) {
  await query('UPDATE users SET share_recordings = $1 WHERE id = $2', [!!allowed, userId]);
}

// Runs on `client` when given (inside a transaction), otherwise on the pool.
async function createUser(name, ailmentTags = [], password = null, role = 'patient', client = null) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  const hash = password ? await hashPassword(password) : null;
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    'INSERT INTO users (name, ailment_tags, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, ailmentTags.join(','), hash, role]);
  return res.rows[0];
}

async function getUser(id) {
  if (!validId(id)) return undefined;
  return first('SELECT * FROM users WHERE id = $1', [id]);
}

// Case-insensitive, so "sol" and "Sol" are the same account.
async function getUserByName(name) {
  return first('SELECT * FROM users WHERE lower(name) = lower($1)', [String(name).trim()]);
}

async function authenticate(name, password) {
  const user = await getUserByName(name);
  // Hash even when the name is unknown, so timing doesn't reveal which names exist.
  const good = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  return user && good ? user : null;
}
const DUMMY_HASH = `${'00'.repeat(16)}$${'00'.repeat(32)}`;

// Used by a developer tool, not reachable from the app.
async function setPassword(userId, newPassword) {
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), userId]);
}

// ---------------------------------------------------------------
// Invite codes (therapist signup)
// ---------------------------------------------------------------
// Codes are compared by hash and are case/space-insensitive.
function hashInvite(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

// Letters and digits without 0/O/1/I, so a code read aloud is hard to get wrong.
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function createInviteCode(createdByUserId) {
  const pick = () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  const chunk = () => Array.from({ length: 4 }, pick).join('');
  const code = `ARMUP-${chunk()}-${chunk()}`;
  await query('INSERT INTO invite_codes (code_hash, created_by, created_at) VALUES ($1, $2, now())',
    [hashInvite(code), createdByUserId]);
  return code; // shown once; only the hash is stored
}

// Creates a therapist and marks the code used, all-or-nothing. Returns the new
// user, or null if the code doesn't exist or was already used.
async function createTherapistWithInvite(name, password, inviteCode) {
  return transaction(async (c) => {
    // FOR UPDATE: two people typing the same code at once can't both win.
    const found = await c.query(
      'SELECT id FROM invite_codes WHERE code_hash = $1 AND used_by IS NULL FOR UPDATE',
      [hashInvite(inviteCode)]);
    if (!found.rowCount) return null;
    const user = await createUser(name, [], password, 'therapist', c);
    await c.query('UPDATE invite_codes SET used_by = $1, used_at = now() WHERE id = $2', [user.id, found.rows[0].id]);
    return user;
  });
}

// ---------------------------------------------------------------
// Sessions and recordings
// ---------------------------------------------------------------
async function getSession(id) {
  if (!validId(id)) return undefined;
  return first('SELECT * FROM session_logs WHERE id = $1', [id]);
}

async function setHasRecording(sessionId, has) {
  await query('UPDATE session_logs SET has_recording = $1 WHERE id = $2', [!!has, sessionId]);
}

// Keeps only the form faults we know about, as whole counts from 0 to 1000.
// Returns null when nothing was sent (an older client), so "not recorded" stays
// different from "recorded, no faults" ({}).
function cleanFormFaults(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const id of FORM_FAULT_IDS) {
    const n = Number(raw[id]);
    if (Number.isInteger(n) && n > 0) out[id] = Math.min(n, 1000);
  }
  return out;
}

async function logSession(userId, exerciseKey, reps, score, accuracy, maxStreak, level, formFaults) {
  const faults = cleanFormFaults(formFaults);
  return first(
    `INSERT INTO session_logs
       (user_id, exercise_key, timestamp, reps, score, accuracy, max_streak, level, form_faults)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, exerciseKey, reps, score, accuracy, maxStreak, level, faults === null ? null : JSON.stringify(faults)]);
}

const getHistory = (userId) =>
  rows('SELECT * FROM session_logs WHERE user_id = $1 ORDER BY timestamp, id', [userId]);

function publicSession(s) {
  return {
    id: s.id,
    exercise_key: s.exercise_key,
    timestamp: iso(s.timestamp),
    reps: s.reps,
    score: s.score,
    accuracy: s.accuracy,
    max_streak: s.max_streak,
    level: s.level,
    form_faults: parseFormFaults(s.form_faults),
    has_recording: !!s.has_recording,
  };
}

// null = not recorded (older session); {} = recorded, no faults.
function parseFormFaults(text) {
  if (text === null || text === undefined) return null;
  try {
    return cleanFormFaults(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// Therapist list of patients
// ---------------------------------------------------------------
// One row per patient with a quick progress summary.
async function listPatientSummaries() {
  const result = await rows(
    `SELECT u.id, u.name, u.ailment_tags,
            COUNT(s.id)::int AS session_count,
            COALESCE(SUM(s.reps), 0)::int AS total_reps,
            -- Koi chase has no misses, so it is saved as 100% accuracy; leave it out of the average
            AVG(CASE WHEN s.exercise_key = 'koi' THEN NULL ELSE s.accuracy END)::float8 AS avg_accuracy,
            MAX(s.timestamp) AS last_session
     FROM users u LEFT JOIN session_logs s ON s.user_id = u.id
     WHERE u.role = 'patient'
     GROUP BY u.id
     ORDER BY lower(u.name), u.id`);
  return result.map((r) => ({
    id: r.id,
    name: r.name,
    ailment_tags: tagsOf(r),
    session_count: r.session_count,
    total_reps: r.total_reps,
    avg_accuracy: r.avg_accuracy === null ? null : Math.round(r.avg_accuracy),
    last_session: iso(r.last_session),
  }));
}

// ---------------------------------------------------------------
// Exercises and plans
// ---------------------------------------------------------------
// Exercises a therapist can prescribe (games excluded).
async function listExercises() {
  return (await rows('SELECT key, name FROM exercises ORDER BY key')).filter((e) => !GAME_KEYS.includes(e.key));
}

// Everything a session can be recorded against: exercises plus games.
async function listSessionKeys() {
  return (await rows('SELECT key FROM exercises')).map((e) => e.key);
}

async function listConditions() {
  const names = Object.fromEntries((await listExercises()).map((e) => [e.key, e.name]));
  const mapRows = await rows('SELECT * FROM ailment_exercise_map ORDER BY ailment_tag, priority, id');
  const grouped = new Map();
  for (const r of mapRows) {
    if (!grouped.has(r.ailment_tag)) grouped.set(r.ailment_tag, []);
    grouped.get(r.ailment_tag).push(names[r.exercise_key] || r.exercise_key);
  }
  const conditions = [...grouped].map(([tag, exercises]) => ({
    tag,
    label: CONDITION_LABELS[tag] || tag.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    exercises,
  }));
  return conditions.sort((a, b) => a.label.localeCompare(b.label));
}

const getPlanRows = (userId) =>
  rows('SELECT * FROM patient_plan WHERE user_id = $1 ORDER BY position', [userId]);

// What the patient is prescribed. A therapist's custom plan wins; otherwise
// the default plan from the patient's conditions.
async function getRecommendedExercises(userId) {
  const custom = await getPlanRows(userId);
  if (custom.length) {
    return custom.map((r) => ({
      exercise_key: r.exercise_key,
      priority: r.position + 1,
      starting_tolerance: null,
      reps_per_set: r.reps_per_set,
      custom: true,
    }));
  }
  const user = await getUser(userId);
  if (!user || !tagsOf(user).length) return [];
  const mapRows = await rows(
    'SELECT * FROM ailment_exercise_map WHERE ailment_tag = ANY($1) ORDER BY priority, id',
    [tagsOf(user)]);
  // Two conditions can prescribe the same exercise: show it once, using its
  // highest-priority (lowest number) row.
  const plan = new Map();
  for (const r of mapRows) if (!plan.has(r.exercise_key)) plan.set(r.exercise_key, r);
  return [...plan.values()].map((r) => ({ ...r, reps_per_set: null, custom: false }));
}

// items: [{ key, reps_per_set }] in the order they should be shown.
// Replaces the whole plan, all-or-nothing.
async function setPlan(userId, therapistId, items) {
  await transaction(async (c) => {
    await c.query('DELETE FROM patient_plan WHERE user_id = $1', [userId]);
    for (let i = 0; i < items.length; i++) {
      await c.query(
        `INSERT INTO patient_plan (user_id, exercise_key, reps_per_set, position, set_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [userId, items[i].key, items[i].reps_per_set, i, therapistId]);
    }
  });
}

const clearPlan = (userId) => query('DELETE FROM patient_plan WHERE user_id = $1', [userId]);

// ---------------------------------------------------------------
// Therapist notes
// ---------------------------------------------------------------
function publicNote(n) {
  return {
    id: n.id,
    body: n.body,
    created_at: iso(n.created_at),
    therapist_id: n.therapist_id,
    therapist_name: n.therapist_name,
  };
}

const NOTE_SELECT = `SELECT n.*, u.name AS therapist_name FROM therapist_notes n
  JOIN users u ON u.id = n.therapist_id`;

async function addNote(patientId, therapistId, body) {
  const made = await first(
    'INSERT INTO therapist_notes (patient_id, therapist_id, body, created_at) VALUES ($1, $2, $3, now()) RETURNING id',
    [patientId, therapistId, body]);
  return first(`${NOTE_SELECT} WHERE n.id = $1`, [made.id]);
}

// Newest first.
const listNotes = (patientId) => rows(`${NOTE_SELECT} WHERE n.patient_id = $1 ORDER BY n.id DESC`, [patientId]);

// A therapist can delete only their own notes. Returns true if one was removed.
async function deleteNote(noteId, therapistId) {
  if (!validId(noteId)) return false;
  const res = await query('DELETE FROM therapist_notes WHERE id = $1 AND therapist_id = $2', [noteId, therapistId]);
  return res.rowCount > 0;
}

// ---------------------------------------------------------------
// Appointments (the rules live in appointments.cjs)
// ---------------------------------------------------------------
const APPT_SELECT = `SELECT a.*, p.name AS patient_name, t.name AS therapist_name
  FROM appointments a
  JOIN users p ON p.id = a.patient_id
  JOIN users t ON t.id = a.therapist_id`;

function publicAppointment(a) {
  return {
    id: a.id,
    patient_id: a.patient_id,
    patient_name: a.patient_name,
    therapist_id: a.therapist_id,
    therapist_name: a.therapist_name,
    starts_at: iso(a.starts_at),
    duration_min: a.duration_min,
    note: a.note,
    status: a.status,
    requested_by: a.requested_by,
  };
}

async function getAppointment(id) {
  if (!validId(id)) return undefined;
  return first(`${APPT_SELECT} WHERE a.id = $1`, [id]);
}

async function createAppointment({ patientId, therapistId, startsAt, durationMin, note, status, requestedBy }) {
  const made = await first(
    `INSERT INTO appointments
       (patient_id, therapist_id, starts_at, duration_min, note, status, requested_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) RETURNING id`,
    [patientId, therapistId, startsAt, durationMin, note, status, requestedBy]);
  return getAppointment(made.id);
}

// A therapist's own appointments, or a patient's own. Soonest first.
function listAppointments(role, userId) {
  const column = role === 'therapist' ? 'a.therapist_id' : 'a.patient_id';
  return rows(`${APPT_SELECT} WHERE ${column} = $1 ORDER BY a.starts_at, a.id`, [userId]);
}

// startsAt / requestedBy are only given when they change (rescheduling).
async function updateAppointment(id, { status, startsAt, requestedBy }) {
  await query(
    `UPDATE appointments
     SET status = $1, starts_at = COALESCE($2, starts_at), requested_by = COALESCE($3, requested_by), updated_at = now()
     WHERE id = $4`,
    [status, startsAt ?? null, requestedBy ?? null, id]);
  return getAppointment(id);
}

// Is this person ('patient_id' or 'therapist_id') already booked at that time?
async function hasBookedOverlap(column, userId, startsAt, durationMin, excludeId = 0) {
  if (column !== 'patient_id' && column !== 'therapist_id') throw new Error('bad column');
  const found = await rows(
    `SELECT starts_at, duration_min FROM appointments
     WHERE ${column} = $1 AND id <> $2 AND status = ANY($3)`,
    [userId, excludeId, appointmentRules.BOOKED]);
  return found.some((r) => appointmentRules.overlaps(iso(r.starts_at), r.duration_min, startsAt, durationMin));
}

// For the patient's "request an appointment" picker. Names only.
const listTherapists = () =>
  rows("SELECT id, name FROM users WHERE role = 'therapist' ORDER BY lower(name), id");

module.exports = {
  openDb, closeDb, query, createUser, getUser, getUserByName, authenticate, listExercises, listSessionKeys,
  listConditions, getRecommendedExercises, logSession, getHistory,
  publicUser, publicSession, hashPassword, verifyPassword,
  createInviteCode, createTherapistWithInvite, ROLES, listPatientSummaries,
  setPassword, setShareRecordings, getSession, setHasRecording, getPlanRows, setPlan, clearPlan,
  publicNote, addNote, listNotes, deleteNote,
  PLAN_MIN_REPS, PLAN_MAX_REPS, NOTE_MAX_LEN,
  createAppointment, getAppointment, listAppointments, updateAppointment, hasBookedOverlap,
  publicAppointment, listTherapists,
};
