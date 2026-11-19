import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportHtml, escapeHtml, summarise, reportFileName } from './reportPdf.js';

const sessions = [
  { id: 1, timestamp: '2026-11-15T10:00:00', exercise_key: 'curl', reps: 10, accuracy: 90, max_streak: 7, score: 100, form_faults: { elbow_drift: 3 } },
  { id: 2, timestamp: '2026-11-16T10:00:00', exercise_key: 'koi', reps: 8, accuracy: 100, max_streak: 0, score: 80, form_faults: null },
  { id: 3, timestamp: '2026-11-17T10:00:00', exercise_key: 'raise', reps: 10, accuracy: 70, max_streak: 4, score: 90, form_faults: {} },
];

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<b onclick="x">&\''), '&lt;b onclick=&quot;x&quot;&gt;&amp;&#39;');
});

test('summary matches the dashboard rules (koi left out of accuracy)', () => {
  const s = summarise(sessions);
  assert.equal(s.sessionCount, 3);
  assert.equal(s.totalReps, 28);
  assert.equal(s.avgAccuracy, 80);
  assert.equal(s.bestStreak, 7);
});

test('empty history still builds a report', () => {
  const html = buildReportHtml({ user: { name: 'Asha' }, sessions: [] });
  assert.match(html, /No sessions logged yet/);
  assert.match(html, /Asha/);
});

test('report shows form flags and escapes patient-controlled text', () => {
  const html = buildReportHtml({
    user: { name: '<script>alert(1)</script>', ailment_tags: ['frozen_shoulder'] },
    sessions,
    notes: [{ body: '<img src=x>', therapist_name: 'Dr A', created_at: '2026-11-18T09:00:00' }],
    plan: [{ name: 'Bicep Curl', custom: true, reps_per_set: 12 }],
  });
  assert.match(html, /Elbow drifting ×3/);
  assert.match(html, /frozen shoulder/);
  assert.match(html, /12 reps per set/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x>'));
});

test('file name includes the patient and date', () => {
  assert.equal(reportFileName({ name: 'Asha' }, new Date('2026-11-20T00:00:00Z')), 'ArmUp report - Asha - 2026-11-20');
});
