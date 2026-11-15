/*
 * appointments.cjs -- the rules for appointments, with no database in it so
 * they can be tested on their own.
 *
 * Life of an appointment:
 *   therapist books  -> scheduled  --patient confirms--> confirmed
 *   patient requests -> requested  --therapist approves--> confirmed
 * Either side can cancel while it is open; a therapist can decline a request
 * or mark a confirmed one completed; either side can suggest a new time.
 * (Whoever did NOT suggest the new time has to agree to it.)
 */
const DURATIONS = [15, 30, 45, 60]; // minutes
const DEFAULT_DURATION = 30;
const NOTE_MAX_LEN = 300;
const MAX_DAYS_AHEAD = 366;

// Statuses that still count as "on the calendar" for double-booking checks.
const BOOKED = ['scheduled', 'confirmed'];
const OPEN = ['requested', 'scheduled', 'confirmed'];

const TRANSITIONS = {
  therapist: {
    approve:    { requested: 'confirmed' },
    decline:    { requested: 'declined' },
    cancel:     { requested: 'cancelled', scheduled: 'cancelled', confirmed: 'cancelled' },
    reschedule: { requested: 'scheduled', scheduled: 'scheduled', confirmed: 'scheduled' },
    complete:   { scheduled: 'completed', confirmed: 'completed' },
  },
  patient: {
    confirm:    { scheduled: 'confirmed' },
    cancel:     { requested: 'cancelled', scheduled: 'cancelled', confirmed: 'cancelled' },
    reschedule: { requested: 'requested', scheduled: 'requested', confirmed: 'requested' },
  },
};

// The status after `action`, or null when this role can't do that to an
// appointment in this status.
function nextStatus(role, status, action) {
  return TRANSITIONS[role]?.[action]?.[status] ?? null;
}

// A start time from the page: an ISO string that is in the future (and not
// absurdly far away). Returns { date } or { error }.
function parseStart(value, now = new Date()) {
  if (typeof value !== 'string' || !value) return { error: 'Please choose a date and time.' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: 'That date and time is not valid.' };
  if (date.getTime() < now.getTime()) return { error: 'Please choose a time in the future.' };
  if (date.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86400000) {
    return { error: 'Please choose a date within the next year.' };
  }
  return { date };
}

// Minutes, from the allowed list. Returns null when it isn't one of them.
function cleanDuration(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DURATION;
  const n = Number(value);
  return DURATIONS.includes(n) ? n : null;
}

function cleanNote(value) {
  const text = String(value ?? '').trim();
  return text.length > NOTE_MAX_LEN
    ? { error: `The note can be at most ${NOTE_MAX_LEN} characters.` }
    : { note: text };
}

// Do two time slots share any time? (Back-to-back slots do not overlap.)
function overlaps(startA, minutesA, startB, minutesB) {
  const a0 = new Date(startA).getTime(), a1 = a0 + minutesA * 60000;
  const b0 = new Date(startB).getTime(), b1 = b0 + minutesB * 60000;
  return a0 < b1 && b0 < a1;
}

module.exports = {
  DURATIONS, DEFAULT_DURATION, NOTE_MAX_LEN, BOOKED, OPEN,
  nextStatus, parseStart, cleanDuration, cleanNote, overlaps,
};
