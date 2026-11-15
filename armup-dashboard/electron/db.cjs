/*
 * db.cjs -- Node port of backend/armup_db.py
 * ------------------------------------------
 * Same SQLite file format, same table names, same password-hash format
 * ("salt_hex$digest_hex", PBKDF2-SHA256, 200,000 rounds), so an armup.db
 * created by the old Python backend opens here unchanged, and logins keep
 * working.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const PBKDF2_ROUNDS = 200_000;

// Mirrors EXERCISES in src/engine.js. Only the keys + names are needed here.
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

// Handed out for the demo. Change these before real use.
const DEMO_INVITE_CODES = ['ARMUP-THERAPIST-1', 'ARMUP-THERAPIST-2', 'ARMUP-THERAPIST-3'];
const ROLES = ['patient', 'therapist'];
// Form faults the rep engine can flag (see FORM_RULES in src/engine.js).
const FORM_FAULT_IDS = ['elbow_drift', 'too_high', 'lean_back'];
const PLAN_MIN_REPS = 3;
const PLAN_MAX_REPS = 30;
const NOTE_MAX_LEN = 1000;

let db = null;

// ---------------------------------------------------------------
// Open + schema
// ---------------------------------------------------------------
function openDb(dbPath, { legacyDbPath } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // First run in dev: pick up the old Python database so existing accounts
  // and sessions carry over. Never overwrites an existing file.
  if (!fs.existsSync(dbPath) && legacyDbPath && fs.existsSync(legacyDbPath)) {
    fs.copyFileSync(legacyDbPath, dbPath);
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  seedAll();
  return db;
}

function initSchema() {
  // Column types match what SQLAlchemy created, so both languages can share the file.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR NOT NULL,
      ailment_tags VARCHAR DEFAULT '',
      password_hash VARCHAR,
      role VARCHAR NOT NULL DEFAULT 'patient',
      -- 1 = the patient agreed that their therapist may watch recordings of their sets
      share_recordings INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS exercises (
      key VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      exercise_key VARCHAR NOT NULL REFERENCES exercises(key),
      timestamp DATETIME,
      reps INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      accuracy FLOAT DEFAULT 0.0,
      max_streak INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      form_faults TEXT,
      has_recording INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ailment_exercise_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ailment_tag VARCHAR NOT NULL,
      exercise_key VARCHAR NOT NULL REFERENCES exercises(key),
      starting_tolerance FLOAT,
      priority INTEGER DEFAULT 1
    );
    -- A therapist's custom exercise plan for one patient. No rows = the patient
    -- uses the default plan that comes from their conditions.
    CREATE TABLE IF NOT EXISTS patient_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      exercise_key VARCHAR NOT NULL,
      reps_per_set INTEGER NOT NULL,
      position INTEGER NOT NULL,
      set_by INTEGER REFERENCES users(id),
      updated_at DATETIME,
      UNIQUE (user_id, exercise_key)
    );
    -- Notes a therapist leaves for a patient.
    CREATE TABLE IF NOT EXISTS therapist_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      therapist_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at DATETIME
    );
    -- Single-use therapist invite codes. Only a hash of each code is stored.
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash VARCHAR NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME,
      used_by INTEGER REFERENCES users(id),
      used_at DATETIME
    );
  `);
  // Old databases from before login existed
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash VARCHAR');
  }
  // Databases from before roles existed: everyone already in there is a patient.
  // Sessions saved before form tracking have no form data (NULL = "not recorded").
  const sessionCols = db.prepare('PRAGMA table_info(session_logs)').all().map((c) => c.name);
  if (!sessionCols.includes('form_faults')) {
    db.exec('ALTER TABLE session_logs ADD COLUMN form_faults TEXT');
  }
  if (!sessionCols.includes('has_recording')) {
    db.exec('ALTER TABLE session_logs ADD COLUMN has_recording INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('share_recordings')) {
    db.exec('ALTER TABLE users ADD COLUMN share_recordings INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role VARCHAR NOT NULL DEFAULT 'patient'");
  }
}

function seedAll() {
  if (!db.prepare('SELECT 1 FROM exercises LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO exercises (key, name) VALUES (?, ?)');
    db.transaction(() => SEED_EXERCISES.forEach((e) => ins.run(...e)))();
  }
  // Runs on every start so existing databases pick up newly added games.
  const insGame = db.prepare('INSERT OR IGNORE INTO exercises (key, name) VALUES (?, ?)');
  db.transaction(() => SEED_GAMES.forEach((e) => insGame.run(...e)))();
  if (!db.prepare('SELECT 1 FROM ailment_exercise_map LIMIT 1').get()) {
    const ins = db.prepare(
      'INSERT INTO ailment_exercise_map (ailment_tag, exercise_key, starting_tolerance, priority) VALUES (?, ?, ?, ?)'
    );
    db.transaction(() => SEED_AILMENT_MAP.forEach((r) => ins.run(...r)))();
  }
  // The landing page's "Continue as test patient" opens user #1, so a brand
  // new database needs one. Skipped when any user already exists.
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    createUser('Demo Patient', ['neck_stiffness'], 'demo1234');
  }
  // First-run therapist invite codes so a fresh install can create its first
  // therapist. These are demo values; a therapist can generate more from the
  // dashboard once logged in.
  if (!db.prepare('SELECT 1 FROM invite_codes LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO invite_codes (code_hash, created_at) VALUES (?, ?)');
    db.transaction(() => DEMO_INVITE_CODES.forEach((c) => ins.run(hashInvite(c), nowUtcForDb())))();
  }
}

// ---------------------------------------------------------------
// Passwords (same format as the Python version)
// ---------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.pbkdf2Sync(password, salt, PBKDF2_ROUNDS, 32, 'sha256');
  return `${salt.toString('hex')}$${digest.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 2) return false;
  try {
    const salt = Buffer.from(parts[0], 'hex');
    const expected = Buffer.from(parts[1], 'hex');
    const digest = crypto.pbkdf2Sync(password, salt, PBKDF2_ROUNDS, expected.length, 'sha256');
    return expected.length > 0 && crypto.timingSafeEqual(digest, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Timestamps. SQLAlchemy stores naive UTC as "YYYY-MM-DD HH:MM:SS.ffffff".
// We write the same shape and return ISO with a trailing Z.
// ---------------------------------------------------------------
function nowUtcForDb() {
  // 2026-11-11T12:00:00.123Z -> 2026-11-11 12:00:00.123000
  return new Date().toISOString().replace('T', ' ').replace('Z', '') + '000';
}

function utcIso(dbValue) {
  if (!dbValue) return dbValue;
  const s = String(dbValue).replace(' ', 'T');
  return /[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z';
}

// ---------------------------------------------------------------
// Queries
// ---------------------------------------------------------------
const tagsOf = (user) => (user.ailment_tags || '').split(',').filter(Boolean);

function publicUser(user) {
  return {
    id: user.id, name: user.name, ailment_tags: tagsOf(user), role: user.role,
    share_recordings: !!user.share_recordings,
  };
}

function setShareRecordings(userId, allowed) {
  db.prepare('UPDATE users SET share_recordings = ? WHERE id = ?').run(allowed ? 1 : 0, userId);
}

// ---------------------------------------------------------------
// Recordings (the video files themselves live in recordings.cjs)
// ---------------------------------------------------------------
function getSession(id) {
  return db.prepare('SELECT * FROM session_logs WHERE id = ?').get(id);
}

function setHasRecording(sessionId, has) {
  db.prepare('UPDATE session_logs SET has_recording = ? WHERE id = ?').run(has ? 1 : 0, sessionId);
}

// Sessions whose recording is older than `days`, for the startup clean-up.
function listExpiredRecordingIds(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').replace('Z', '') + '000';
  return db
    .prepare('SELECT id FROM session_logs WHERE has_recording = 1 AND timestamp < ?')
    .all(cutoff)
    .map((r) => r.id);
}

function createUser(name, ailmentTags = [], password = null, role = 'patient') {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  const info = db
    .prepare('INSERT INTO users (name, ailment_tags, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, ailmentTags.join(','), password ? hashPassword(password) : null, role);
  return getUser(Number(info.lastInsertRowid));
}

// ---------------------------------------------------------------
// Invite codes (therapist signup)
// ---------------------------------------------------------------
// Codes are compared by hash and are case/space-insensitive.
function hashInvite(code) {
  return crypto
    .createHash('sha256')
    .update(String(code).trim().toUpperCase())
    .digest('hex');
}

// Letters and digits without 0/O/1/I, so a code read aloud or typed from a
// screenshot is hard to get wrong. ARMUP-XXXX-XXXX = 8 random characters.
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createInviteCode(createdByUserId) {
  const pick = () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  const chunk = () => Array.from({ length: 4 }, pick).join('');
  const code = `ARMUP-${chunk()}-${chunk()}`;
  db.prepare('INSERT INTO invite_codes (code_hash, created_by, created_at) VALUES (?, ?, ?)')
    .run(hashInvite(code), createdByUserId, nowUtcForDb());
  return code; // shown once; only the hash is stored
}

// Creates a therapist and marks the code used, all-or-nothing. Returns the new
// user, or null if the code doesn't exist or was already used.
function createTherapistWithInvite(name, password, inviteCode) {
  const run = db.transaction(() => {
    const row = db
      .prepare('SELECT id FROM invite_codes WHERE code_hash = ? AND used_by IS NULL')
      .get(hashInvite(inviteCode));
    if (!row) return null;
    const user = createUser(name, [], password, 'therapist');
    db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ?')
      .run(user.id, nowUtcForDb(), row.id);
    return user;
  });
  return run();
}

// Used by reset-password.cjs (a developer tool, not reachable from the app).
function setPassword(userId, newPassword) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByName(name) {
  // Case-insensitive, so "sol" and "Sol" are the same account.
  return db.prepare('SELECT * FROM users WHERE lower(name) = lower(?)').get(name.trim());
}

function authenticate(name, password) {
  const user = getUserByName(name);
  return user && verifyPassword(password, user.password_hash) ? user : null;
}

// One row per patient with a quick progress summary, for the therapist's list.
function listPatientSummaries() {
  return db
    .prepare(
      `SELECT u.id, u.name, u.ailment_tags,
              COUNT(s.id) AS session_count,
              COALESCE(SUM(s.reps), 0) AS total_reps,
              -- Koi chase has no misses, so it is saved as 100% accuracy; leave it out of the average
              AVG(CASE WHEN s.exercise_key = 'koi' THEN NULL ELSE s.accuracy END) AS avg_accuracy,
              MAX(s.timestamp) AS last_session
       FROM users u LEFT JOIN session_logs s ON s.user_id = u.id
       WHERE u.role = 'patient'
       GROUP BY u.id
       ORDER BY u.name COLLATE NOCASE`
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      ailment_tags: tagsOf(r),
      session_count: r.session_count,
      total_reps: r.total_reps,
      avg_accuracy: r.avg_accuracy === null ? null : Math.round(r.avg_accuracy),
      last_session: utcIso(r.last_session),
    }));
}

// Exercises a therapist can prescribe (games excluded).
function listExercises() {
  return db.prepare('SELECT key, name FROM exercises').all().filter((e) => !GAME_KEYS.includes(e.key));
}

// Everything a session can be recorded against: exercises plus games.
function listSessionKeys() {
  return db.prepare('SELECT key FROM exercises').all().map((e) => e.key);
}

function listConditions() {
  const names = Object.fromEntries(listExercises().map((e) => [e.key, e.name]));
  const rows = db
    .prepare('SELECT * FROM ailment_exercise_map ORDER BY ailment_tag, priority')
    .all();
  const grouped = new Map();
  for (const r of rows) {
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

// What the patient is prescribed. A therapist's custom plan wins; otherwise
// the default plan from the patient's conditions. Each row has:
// exercise_key, priority, starting_tolerance, reps_per_set (null = default
// set size), custom (true when it comes from a therapist's plan).
function getRecommendedExercises(userId) {
  const custom = getPlanRows(userId);
  if (custom.length) {
    return custom.map((r) => ({
      exercise_key: r.exercise_key,
      priority: r.position + 1,
      starting_tolerance: null,
      reps_per_set: r.reps_per_set,
      custom: true,
    }));
  }
  const user = getUser(userId);
  if (!user || !tagsOf(user).length) return [];
  const tags = tagsOf(user);
  const rows = db
    .prepare(
      `SELECT * FROM ailment_exercise_map
       WHERE ailment_tag IN (${tags.map(() => '?').join(',')})
       ORDER BY priority, id`
    )
    .all(...tags);
  // Two conditions can prescribe the same exercise: show it once, using its
  // highest-priority (lowest number) row.
  const plan = new Map();
  for (const r of rows) if (!plan.has(r.exercise_key)) plan.set(r.exercise_key, r);
  return [...plan.values()].map((r) => ({ ...r, reps_per_set: null, custom: false }));
}

// ---------------------------------------------------------------
// Custom exercise plans (set by a therapist)
// ---------------------------------------------------------------
function getPlanRows(userId) {
  return db
    .prepare('SELECT * FROM patient_plan WHERE user_id = ? ORDER BY position')
    .all(userId);
}

// items: [{ key, reps_per_set }] in the order they should be shown.
// Replaces the whole plan, all-or-nothing.
function setPlan(userId, therapistId, items) {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM patient_plan WHERE user_id = ?').run(userId);
    const ins = db.prepare(
      `INSERT INTO patient_plan (user_id, exercise_key, reps_per_set, position, set_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    items.forEach((it, i) => ins.run(userId, it.key, it.reps_per_set, i, therapistId, nowUtcForDb()));
  });
  run();
}

function clearPlan(userId) {
  db.prepare('DELETE FROM patient_plan WHERE user_id = ?').run(userId);
}

// ---------------------------------------------------------------
// Therapist notes
// ---------------------------------------------------------------
function publicNote(n) {
  return {
    id: n.id,
    body: n.body,
    created_at: utcIso(n.created_at),
    therapist_id: n.therapist_id,
    therapist_name: n.therapist_name,
  };
}

function addNote(patientId, therapistId, body) {
  const info = db
    .prepare('INSERT INTO therapist_notes (patient_id, therapist_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(patientId, therapistId, body, nowUtcForDb());
  return getNote(Number(info.lastInsertRowid));
}

function getNote(id) {
  return db
    .prepare(
      `SELECT n.*, u.name AS therapist_name FROM therapist_notes n
       JOIN users u ON u.id = n.therapist_id WHERE n.id = ?`
    )
    .get(id);
}

// Newest first.
function listNotes(patientId) {
  return db
    .prepare(
      `SELECT n.*, u.name AS therapist_name FROM therapist_notes n
       JOIN users u ON u.id = n.therapist_id
       WHERE n.patient_id = ? ORDER BY n.id DESC`
    )
    .all(patientId);
}

// A therapist can delete only their own notes. Returns true if one was removed.
function deleteNote(noteId, therapistId) {
  return db.prepare('DELETE FROM therapist_notes WHERE id = ? AND therapist_id = ?')
    .run(noteId, therapistId).changes > 0;
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

function logSession(userId, exerciseKey, reps, score, accuracy, maxStreak, level, formFaults) {
  const faults = cleanFormFaults(formFaults);
  const info = db
    .prepare(
      `INSERT INTO session_logs
         (user_id, exercise_key, timestamp, reps, score, accuracy, max_streak, level, form_faults)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, exerciseKey, nowUtcForDb(), reps, score, accuracy, maxStreak, level,
      faults === null ? null : JSON.stringify(faults));
  return db.prepare('SELECT * FROM session_logs WHERE id = ?').get(Number(info.lastInsertRowid));
}

function getHistory(userId) {
  return db
    .prepare('SELECT * FROM session_logs WHERE user_id = ? ORDER BY timestamp, id')
    .all(userId);
}

function publicSession(s) {
  return {
    id: s.id,
    exercise_key: s.exercise_key,
    timestamp: utcIso(s.timestamp),
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

module.exports = {
  openDb, createUser, getUser, getUserByName, authenticate, listExercises, listSessionKeys,
  listConditions, getRecommendedExercises, logSession, getHistory,
  publicUser, publicSession, hashPassword, verifyPassword,
  createInviteCode, createTherapistWithInvite, ROLES, listPatientSummaries,
  setPassword, setShareRecordings, getSession, setHasRecording, listExpiredRecordingIds, getPlanRows, setPlan, clearPlan, publicNote, addNote, listNotes, deleteNote,
  PLAN_MIN_REPS, PLAN_MAX_REPS, NOTE_MAX_LEN,
};
