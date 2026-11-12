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
      password_hash VARCHAR
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
      level INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ailment_exercise_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ailment_tag VARCHAR NOT NULL,
      exercise_key VARCHAR NOT NULL REFERENCES exercises(key),
      starting_tolerance FLOAT,
      priority INTEGER DEFAULT 1
    );
  `);
  // Old databases from before login existed
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash VARCHAR');
  }
}

function seedAll() {
  if (!db.prepare('SELECT 1 FROM exercises LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO exercises (key, name) VALUES (?, ?)');
    db.transaction(() => SEED_EXERCISES.forEach((e) => ins.run(...e)))();
  }
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
  return { id: user.id, name: user.name, ailment_tags: tagsOf(user) };
}

function createUser(name, ailmentTags = [], password = null) {
  const info = db
    .prepare('INSERT INTO users (name, ailment_tags, password_hash) VALUES (?, ?, ?)')
    .run(name, ailmentTags.join(','), password ? hashPassword(password) : null);
  return getUser(Number(info.lastInsertRowid));
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

function listExercises() {
  return db.prepare('SELECT key, name FROM exercises').all();
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

function getRecommendedExercises(userId) {
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
  return [...plan.values()];
}

function logSession(userId, exerciseKey, reps, score, accuracy, maxStreak, level) {
  const info = db
    .prepare(
      `INSERT INTO session_logs
         (user_id, exercise_key, timestamp, reps, score, accuracy, max_streak, level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, exerciseKey, nowUtcForDb(), reps, score, accuracy, maxStreak, level);
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
  };
}

module.exports = {
  openDb, createUser, getUser, getUserByName, authenticate, listExercises,
  listConditions, getRecommendedExercises, logSession, getHistory,
  publicUser, publicSession, hashPassword, verifyPassword,
};
