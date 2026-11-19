// Builds the HTML for the patient's "Download my report (PDF)" file.
// Pure functions only (no React, no Electron), so they can be tested alone.
// The HTML is printed to PDF by the main process (electron/pdf-export.cjs).

const EXERCISE_NAMES = {
  curl: 'Bicep Curl',
  raise: 'Lateral Raise',
  press: 'Shoulder Press',
  neck_tilt: 'Owl Neck Tilt',
  koi: 'Koi Chase',
};
const FAULT_LABELS = {
  elbow_drift: 'Elbow drifting',
  too_high: 'Arm too high',
  lean_back: 'Leaning back',
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Session times arrive as UTC without a timezone marker; show them in IST.
function parseUtc(ts) {
  return new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`);
}
function formatIST(ts) {
  const d = parseUtc(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

const exerciseName = (key) => EXERCISE_NAMES[key] || key;

// Same numbers the dashboard shows. Koi sessions have no misses (saved as
// 100%), so they are left out of the accuracy average.
export function summarise(sessions) {
  const scored = sessions.filter((s) => s.exercise_key !== 'koi');
  return {
    sessionCount: sessions.length,
    totalReps: sessions.reduce((a, s) => a + s.reps, 0),
    avgAccuracy: scored.length
      ? Math.round(scored.reduce((a, s) => a + s.accuracy, 0) / scored.length)
      : null,
    bestStreak: sessions.length ? Math.max(...sessions.map((s) => s.max_streak)) : 0,
  };
}

function faultText(session) {
  if (!session.form_faults) return '—';
  const entries = Object.entries(session.form_faults);
  if (entries.length === 0) return 'Good';
  return entries.map(([id, n]) => `${FAULT_LABELS[id] || id} ×${n}`).join(', ');
}

export function reportFileName(user, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return `ArmUp report - ${user?.name || 'patient'} - ${day}`;
}

export function buildReportHtml({ user, sessions = [], notes = [], plan = [], now = new Date() }) {
  const sum = summarise(sessions);
  const ordered = [...sessions].sort((a, b) => parseUtc(b.timestamp) - parseUtc(a.timestamp));
  const generated = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

  const conditions = (user?.ailment_tags || [])
    .map((t) => escapeHtml(String(t).replace(/_/g, ' ')))
    .join(', ') || '—';

  const sessionRows = ordered.map((s) => `
      <tr>
        <td>${escapeHtml(formatIST(s.timestamp))}</td>
        <td>${escapeHtml(exerciseName(s.exercise_key))}</td>
        <td class="num">${escapeHtml(s.reps)}</td>
        <td class="num">${s.exercise_key === 'koi' ? '—' : `${Math.round(s.accuracy)}%`}</td>
        <td class="num">${escapeHtml(s.max_streak)}</td>
        <td>${escapeHtml(faultText(s))}</td>
      </tr>`).join('');

  const planRows = plan.map((p) => `
      <li>${escapeHtml(p.name)}${p.custom ? ` — ${escapeHtml(p.reps_per_set)} reps per set` : ''}</li>`).join('');

  const noteItems = notes.slice(0, 5).map((n) => `
      <li><p>${escapeHtml(n.body)}</p>
        <small>${escapeHtml(n.therapist_name || 'Therapist')}${
          n.created_at ? ` · ${escapeHtml(formatIST(n.created_at))}` : ''}</small></li>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ArmUp report</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #221E18; font-size: 12px; margin: 0; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 1px solid #E7E2D4; padding-bottom: 4px; }
  .sub { color: #6B5B45; margin: 0 0 16px; }
  .cards { display: flex; gap: 10px; }
  .card { flex: 1; background: #F6F1E7; border-radius: 10px; padding: 10px 12px; }
  .card b { display: block; font-size: 20px; }
  .card span { color: #6B5B45; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; color: #8D8777; border-bottom: 1px solid #E7E2D4; padding: 4px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #F3EFE5; vertical-align: top; }
  .num { text-align: right; }
  tr { page-break-inside: avoid; }
  ul { padding-left: 18px; margin: 0; }
  li { margin-bottom: 6px; }
  li p { margin: 0; white-space: pre-wrap; }
  small { color: #8D8777; }
  .note { margin-top: 24px; font-size: 10px; color: #8D8777; }
</style></head><body>
  <h1>ArmUp progress report</h1>
  <p class="sub">${escapeHtml(user?.name || 'Patient')} · Conditions: ${conditions} · Generated ${escapeHtml(generated)} (IST)</p>

  <div class="cards">
    <div class="card"><b>${sum.sessionCount}</b><span>Sessions</span></div>
    <div class="card"><b>${sum.totalReps}</b><span>Total reps</span></div>
    <div class="card"><b>${sum.avgAccuracy === null ? '—' : `${sum.avgAccuracy}%`}</b><span>Average accuracy</span></div>
    <div class="card"><b>${sum.bestStreak}</b><span>Best streak</span></div>
  </div>

  <h2>Session log</h2>
  ${ordered.length ? `<table>
    <thead><tr><th>When</th><th>Exercise</th><th class="num">Reps</th><th class="num">Accuracy</th><th class="num">Streak</th><th>Form</th></tr></thead>
    <tbody>${sessionRows}</tbody></table>` : '<p>No sessions logged yet.</p>'}

  <h2>Prescribed plan</h2>
  ${plan.length ? `<ul>${planRows}</ul>` : '<p>No prescribed exercises found.</p>'}

  <h2>Notes from your therapist</h2>
  ${notes.length ? `<ul>${noteItems}</ul>` : '<p>No notes yet.</p>'}

  <p class="note">Generated by ArmUp, a non-clinical prototype. Angles and form checks are
  engineering estimates and are not a medical assessment. Please discuss this report with your therapist.</p>
</body></html>`;
}
