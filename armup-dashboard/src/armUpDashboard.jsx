import React, { useState, useEffect } from 'react';
import {
  Activity, Award, CalendarDays, CheckCircle2, Flame, LayoutDashboard,
  ClipboardList, Download, Settings, LogOut, Play, ShieldAlert, User
} from 'lucide-react';
import BrandMark from './BrandMark.jsx';
import GameCanvas from './GameCanvas';
import ExerciseCanvas from './ExerciseCanvas';
import KoiCanvas from './KoiCanvas';
import SettingsPanel from './SettingsPanel';
import AppointmentsPage from './AppointmentsPage';
import { countWaiting } from './appointmentUtils';
import { loadSettings, saveSettings, applySettings, clearSettings } from './displaySettings';
import { usePoseSession } from './usePoseSession';
import { apiFetch } from './api';
import { buildReportHtml, reportFileName } from './reportPdf';


// Pastel palette per exercise -- soft card tints + a darker "ink" shade
// of the same hue for text/dots, so each exercise reads as one color
// family instead of a saturated dark-mode neon.
const EXERCISE_STYLE = {
  curl:       { bg: '#F3D9E2', ink: '#B15C7E', name: 'Bicep Curl' },
  raise:      { bg: '#CFE1EC', ink: '#3E7396', name: 'Lateral Raise' },
  press:      { bg: '#DAD3EF', ink: '#6C5C9A', name: 'Shoulder Press' },
  neck_tilt:  { bg: '#E8E2A8', ink: '#8C8330', name: 'Owl Neck Tilt' },
  koi:        { bg: '#F6DCE8', ink: '#C0577F', name: 'Koi Chase' },
};
const FALLBACK_STYLE = { bg: '#E7E2D4', ink: '#8D8777', name: 'Exercise' };

function exStyle(key) {
  return EXERCISE_STYLE[key] || FALLBACK_STYLE;
}

// The backend stores session times in UTC but sends them without a
// timezone marker ("2026-09-20T07:36:00"), which browsers would read as
// local time and show unconverted. Treat them as UTC, then display in IST.
function parseUtc(ts) {
  return new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`);
}

function formatIST(ts) {
  return parseUtc(ts).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// `view` items switch the page; the others do something else when clicked.
const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, view: 'dashboard' },
  { id: 'appointments', label: 'Appointments', icon: CalendarDays, view: 'appointments' },
  { id: 'session-log', label: 'Session log', icon: ClipboardList, scrollsToLog: true },
  { id: 'settings', label: 'Settings', icon: Settings, opensSettings: true },
];

// The patient's own dashboard. Therapists use TherapistDashboard instead,
// and the main process only lets a patient read their own record.
export default function ArmUpDashboard({ initialUserId = 1, onExit } = {}) {
  const userId = initialUserId;
  const [user, setUser] = useState(null);
  const [recommended, setRecommended] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [notes, setNotes] = useState([]); // from the patient's therapist(s), newest first
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('exercise'); // 'exercise' | 'game' | 'koi'
  const [showSettings, setShowSettings] = useState(false);
  const [pdfState, setPdfState] = useState({ busy: false, message: null }); // "Download my report"
  // Which page is showing. The dashboard stays mounted (just hidden) while
  // Appointments is open, so the camera session is not reset.
  const [view, setView] = useState('dashboard'); // 'dashboard' | 'appointments'
  const [waiting, setWaiting] = useState(0); // appointments waiting for this patient to confirm
  const [display, setDisplay] = useState(() => loadSettings(initialUserId));

  // Apply this patient's text-size / contrast choices while the dashboard
  // is open, and put the page back to normal when they leave it.
  useEffect(() => {
    applySettings(display);
  }, [display]);
  useEffect(() => clearSettings, []);

  const changeDisplay = (next) => {
    setDisplay(next);
    saveSettings(userId, next);
  };

  // One shared camera + MediaPipe + rep-engine session for BOTH modes --
  // see usePoseSession.js for why this can't live inside each canvas.
  const pose = usePoseSession({ initialExercise: 'curl' });

  useEffect(() => {
    fetchDashboardData(userId);
  }, [userId]);

  // Starting count for the badge on the Appointments menu item.
  useEffect(() => {
    apiFetch('/appointments')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setWaiting(countWaiting('patient', list)))
      .catch(() => {});
  }, [userId]);

  // "Session log" lives on the dashboard page, so go there first if needed.
  const goToSessionLog = () => {
    setView('dashboard');
    setTimeout(() => document.getElementById('session-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  // Save the patient's progress summary as a PDF (printed by the main process).
  const downloadReport = async () => {
    if (pdfState.busy) return;
    if (!window.armup?.report) {
      setPdfState({ busy: false, message: 'PDF export is only available in the desktop app.' });
      return;
    }
    setPdfState({ busy: true, message: null });
    try {
      const html = buildReportHtml({ user, sessions, notes, plan: recommended });
      const res = await window.armup.report.savePdf(html, reportFileName(user));
      setPdfState({
        busy: false,
        message: res?.canceled ? null : res?.ok ? 'Report saved.' : (res?.error || 'Could not create the PDF.'),
      });
    } catch (err) {
      console.error('PDF export failed:', err);
      setPdfState({ busy: false, message: 'Could not create the PDF.' });
    }
  };

  const fetchDashboardData = async (id) => {
    setLoading(true);
    try {
      const [uRes, rRes, sRes, nRes] = await Promise.all([
        apiFetch(`/users/${id}`).then(r => r.ok ? r.json() : null),
        apiFetch(`/users/${id}/exercises`).then(r => r.ok ? r.json() : []),
        apiFetch(`/users/${id}/sessions`).then(r => r.ok ? r.json() : []),
        apiFetch(`/users/${id}/notes`).then(r => r.ok ? r.json() : [])
      ]);
      // A saved login can outlive its account (e.g. armup.db was deleted).
      // Real logins go back to the start; the demo view keeps its old behavior.
      if (!uRes && onExit) {
        onExit();
        return;
      }
      setUser(uRes);
      setRecommended(rRes);
      setSessions(sRes);
      setNotes(nRes);
    } catch (err) {
      console.error("Backend offline or unreachable:", err);
    } finally {
      setLoading(false);
    }
  };

  // Used to spawn the old desktop OpenCV app (armup_app.py) as a
  // separate process. Now that the browser can track pose itself
  // (ExerciseCanvas / GameCanvas via usePoseSession), "Play" on a
  // prescribed exercise just switches the in-page tracker to it and
  // jumps to Exercise mode -- no subprocess, no /start-session call.
  const startExercise = (exerciseKey) => {
    pose.setExercise(exerciseKey);
    setMode('exercise');
    document.getElementById('exercise-stage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Oldest -> newest for the charts below. Sorted here so it doesn't
  // depend on which order the API happens to return sessions in.
  const chronological = [...sessions].sort((a, b) => parseUtc(a.timestamp) - parseUtc(b.timestamp));
  const recent = chronological.slice(-8);

  const totalReps = sessions.reduce((acc, s) => acc + s.reps, 0);
  const totalScore = sessions.reduce((acc, s) => acc + s.score, 0);
  // Koi chase has no misses (saved as 100%), so it doesn't count toward form accuracy.
  const scoredSessions = sessions.filter(s => s.exercise_key !== 'koi');
  const recentScored = recent.filter(s => s.exercise_key !== 'koi');
  const avgAccuracy = scoredSessions.length
    ? Math.round(scoredSessions.reduce((acc, s) => acc + s.accuracy, 0) / scoredSessions.length)
    : null;
  const maxStreak = sessions.length ? Math.max(...sessions.map(s => s.max_streak)) : 0;

  const byExercise = sessions.reduce((acc, s) => {
    acc[s.exercise_key] = (acc[s.exercise_key] || 0) + s.reps;
    return acc;
  }, {});
  const exerciseKeys = Object.keys(byExercise);
  const exerciseTotal = Object.values(byExercise).reduce((a, b) => a + b, 0) || 1;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F6F1E7] text-[#221E18] flex items-center justify-center font-sans">
        <div className="flex items-center gap-3 text-[#6B5B45]">
          <Activity className="animate-spin" size={26} />
          <span className="text-lg font-medium">Loading ArmUp dashboard…</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-[#F6F1E7] text-[#221E18] flex flex-col lg:flex-row"
      style={{ fontFamily: "'Inter', ui-sans-serif, sans-serif" }}
    >
      {/* Font import -- Outfit for headings/labels (rounded, a bit of
          energy, fits a motion/rehab-game app better than a neutral
          system sans), Inter for body/data where plain legibility
          matters more than personality. */}
      <style>{`
        .font-display { font-family: 'Outfit', ui-sans-serif, sans-serif; }
      `}</style>

      {/* Sidebar */}
      <aside className="hidden lg:flex flex-col justify-between w-60 m-4 mr-0 rounded-3xl bg-[#17140F] text-[#E9E4D6] p-5">
        <div>
          <div className="flex items-center gap-2 px-2 mb-8">
            <BrandMark size={32} />
            <span className="font-display text-lg font-semibold tracking-tight">ArmUp</span>
          </div>

          <p className="px-2 text-[11px] uppercase tracking-wide text-[#8D8777] mb-2">General</p>
          <nav className="space-y-1">
            {NAV_ITEMS.map(({ id, label, icon: Icon, view: target, scrollsToLog, opensSettings }) => {
              const current = target && view === target;
              const onClick = target ? () => setView(target) : scrollsToLog ? goToSessionLog : opensSettings ? () => setShowSettings(true) : undefined;
              return (
                <button
                  key={id}
                  onClick={onClick}
                  aria-current={current ? 'page' : undefined}
                  className={`w-full text-left font-display flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
                    current
                      ? 'bg-[#E9E4D6] text-[#17140F] font-medium'
                      : 'text-[#B7B1A0] hover:bg-white/5 hover:text-[#E9E4D6]'
                  }`}
                >
                  <Icon size={16} />
                  {label}
                  {id === 'appointments' && waiting > 0 && (
                    <span className="ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#E8E2A8] text-[#6B6434]">
                      {waiting}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {onExit ? (
          <button
            onClick={onExit}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-[#B7B1A0] hover:bg-white/5 hover:text-[#E9E4D6] transition-colors text-left"
          >
            <LogOut size={16} />
            Log out
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-[#B7B1A0]">
            <LogOut size={16} />
            Log out
          </div>
        )}
      </aside>

      {showSettings && (
        <SettingsPanel settings={display} onChange={changeDisplay} onClose={() => setShowSettings(false)} />
      )}

      {/* Main content */}
      <main className="flex-1 p-4 md:p-8">

        {/* The side menu is hidden on narrow windows, so show the two pages as tabs. */}
        <div className="lg:hidden flex items-center gap-2 mb-4">
          {[
            { id: 'dashboard', label: 'Dashboard' },
            { id: 'appointments', label: 'Appointments' },
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`font-display text-sm px-4 py-2 rounded-full transition-colors ${
                view === id ? 'bg-[#17140F] text-[#E9E4D6]' : 'bg-white border border-[#E7E2D4] text-[#8D8777]'
              }`}
            >
              {label}
              {id === 'appointments' && waiting > 0 ? ` (${waiting})` : ''}
            </button>
          ))}
        </div>

        {view === 'appointments' && <AppointmentsPage role="patient" onWaitingChange={setWaiting} />}

        <div className={view === 'appointments' ? 'hidden' : ''}>

        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
          <div>
            <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-tight">
              {user ? `Reviewing ${user.name}'s progress` : 'Reviewing patient progress'}
            </h1>
            <p className="text-sm text-[#8D8777] mt-1 max-w-md">
              {sessions.length > 0
                ? `${totalReps} reps logged across ${sessions.length} session${sessions.length === 1 ? '' : 's'}${avgAccuracy === null ? '.' : `, averaging ${avgAccuracy}% form accuracy.`}`
                : 'No sessions logged yet for this patient.'}
            </p>
          </div>

          <button
            onClick={() => setShowSettings(true)}
            className="lg:hidden font-display flex items-center gap-2 text-sm px-4 py-2 rounded-full bg-white border border-[#E7E2D4] text-[#6B5B45]"
          >
            <Settings size={16} />
            Settings
          </button>

          <div className="flex items-center gap-3 bg-white border border-[#E7E2D4] p-2 rounded-2xl shadow-sm">
            <User className="text-[#8D8777] ml-2" size={18} />
            <span className="text-xs font-medium text-[#8D8777]">Patient ID</span>
            <span className="w-14 text-center text-sm text-[#221E18] font-mono">{userId}</span>
            <div className="text-sm font-semibold pr-2 border-l border-[#E7E2D4] pl-3">
              {user ? user.name : "Unknown"}
            </div>
          </div>
        </header>

        {/* Mode toggle -- Game mode now renders GameCanvas (render-loop test) */}
        <div className="flex items-center gap-2 mb-8">
          <button
            onClick={() => setMode('exercise')}
            className={`font-display text-sm px-4 py-2 rounded-full transition-colors ${
              mode === 'exercise' ? 'bg-[#17140F] text-[#E9E4D6]' : 'bg-white border border-[#E7E2D4] text-[#8D8777]'
            }`}
          >
            Exercise mode
          </button>
          <button
            onClick={() => setMode('game')}
            className={`font-display text-sm px-4 py-2 rounded-full transition-colors ${
              mode === 'game' ? 'bg-[#17140F] text-[#E9E4D6]' : 'bg-white border border-[#E7E2D4] text-[#8D8777]'
            }`}
          >
            Game mode
          </button>
          <button
            onClick={() => setMode('koi')}
            className={`font-display text-sm px-4 py-2 rounded-full transition-colors ${
              mode === 'koi' ? 'bg-[#17140F] text-[#E9E4D6]' : 'bg-white border border-[#E7E2D4] text-[#8D8777]'
            }`}
          >
            Calm mode
          </button>
        </div>

        {/* Both modes share one camera + tracking session (the `pose`
            object from usePoseSession) -- switching tabs just changes
            which renderer is on screen, never resets reps or re-asks
            for camera permission. Sits above the stat cards below
            rather than replacing them, so this can't break the rest
            of the dashboard layout. */}
        <div id="exercise-stage" className="mb-8 scroll-mt-6">
          {mode === 'exercise' ? (
            <ExerciseCanvas pose={pose} userId={userId} plan={recommended} onSessionSaved={() => fetchDashboardData(userId)} />
          ) : mode === 'koi' ? (
            <KoiCanvas pose={pose} userId={userId} onSessionSaved={() => fetchDashboardData(userId)} />
          ) : (
            <GameCanvas pose={pose} userId={userId} onSessionSaved={() => fetchDashboardData(userId)} />
          )}
        </div>

        {/* Pastel stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 mb-6">

          {/* Reps bar chart */}
          <StatCard bg="#E8E2A8" label="Repetitions" caption="Last sessions">
            <div className="flex items-end gap-1.5 h-16 mt-3">
              {recent.length > 0 ? recent.map((s, i) => {
                const max = Math.max(...recent.map(r => r.reps), 1);
                const h = Math.max(10, Math.round((s.reps / max) * 100));
                return (
                  <div key={i} className="flex-1 rounded-t-md bg-[#17140F]/80" style={{ height: `${h}%` }} title={`${s.reps} reps`} />
                );
              }) : <p className="text-xs text-[#6B6434]">No sessions yet</p>}
            </div>
            <p className="font-display text-2xl font-semibold mt-3">{totalReps}</p>
            <p className="text-xs text-[#6B6434]">total reps logged</p>
          </StatCard>

          {/* Accuracy sparkline */}
          <StatCard bg="#F3D9E2" label="Form accuracy" caption="Trend over time">
            <div className="h-16 mt-3">
              {recentScored.length > 1 ? (
                <Sparkline values={recentScored.map(s => s.accuracy)} stroke="#B15C7E" />
              ) : (
                <p className="text-xs text-[#8A4E68] mt-6">Not enough data yet</p>
              )}
            </div>
            <p className="font-display text-2xl font-semibold mt-3">{avgAccuracy === null ? '—' : `${avgAccuracy}%`}</p>
            <p className="text-xs text-[#8A4E68]">average accuracy</p>
          </StatCard>

          {/* By exercise breakdown */}
          <StatCard bg="#DAD3EF" label="By exercise" caption="Rep share">
            <div className="mt-4 h-3 rounded-full overflow-hidden flex bg-white/50">
              {exerciseKeys.length > 0 ? exerciseKeys.map((key) => (
                <div
                  key={key}
                  style={{ width: `${(byExercise[key] / exerciseTotal) * 100}%`, backgroundColor: exStyle(key).ink }}
                  title={`${exStyle(key).name}: ${byExercise[key]} reps`}
                />
              )) : <div className="w-full bg-white/60" />}
            </div>
            <div className="mt-3 space-y-1">
              {exerciseKeys.length > 0 ? exerciseKeys.slice(0, 3).map((key) => (
                <div key={key} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-[#4B4270]">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: exStyle(key).ink }} />
                    {exStyle(key).name}
                  </span>
                  <span className="font-mono text-[#4B4270]">{byExercise[key]}</span>
                </div>
              )) : <p className="text-xs text-[#6C5C9A]">No exercises logged yet</p>}
            </div>
          </StatCard>

          {/* Streak & sessions */}
          <StatCard bg="#CFE1EC" label="Consistency" caption="Streaks & volume">
            <div className="flex items-end gap-6 mt-4">
              <div>
                <p className="font-display text-2xl font-semibold flex items-center gap-1">
                  <Flame size={18} className="text-[#3E7396]" />
                  {maxStreak}
                </p>
                <p className="text-xs text-[#3E7396]">best streak</p>
              </div>
              <div>
                <p className="font-display text-2xl font-semibold">{sessions.length}</p>
                <p className="text-xs text-[#3E7396]">sessions logged</p>
              </div>
            </div>
            <p className="text-xs text-[#3E7396] mt-3">{totalScore} XP earned total</p>
          </StatCard>
        </div>

        {/* Lower section: session log + prescribed plan */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Session log */}
          <div id="session-log" className="lg:col-span-2 bg-white border border-[#E7E2D4] rounded-3xl p-6 shadow-sm scroll-mt-6">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-semibold">Session log</h3>
                <p className="text-xs text-[#8D8777]">Logged directly from the webcam vision layer</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={downloadReport}
                  disabled={pdfState.busy || sessions.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#221E18] text-white text-xs font-medium hover:bg-[#3a342b] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Download size={14} />
                  {pdfState.busy ? 'Preparing…' : 'Download my report (PDF)'}
                </button>
                {pdfState.message && (
                  <p className="text-[11px] text-[#8D8777]" role="status">{pdfState.message}</p>
                )}
              </div>
            </div>

            {sessions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#EFEAE0] text-[11px] font-medium text-[#8D8777] uppercase tracking-wide">
                      <th className="pb-3">Timestamp</th>
                      <th className="pb-3">Exercise</th>
                      <th className="pb-3">Reps</th>
                      <th className="pb-3">Accuracy</th>
                      <th className="pb-3">Streak</th>
                      <th className="pb-3 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F3EFE5] text-sm">
                    {sessions.map((s) => {
                      const style = exStyle(s.exercise_key);
                      return (
                        <tr key={s.id}>
                          <td className="py-3 font-mono text-xs text-[#8D8777]">
                            {formatIST(s.timestamp)}
                          </td>
                          <td className="py-3">
                            <span
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                              style={{ backgroundColor: style.bg, color: style.ink }}
                            >
                              {style.name}
                            </span>
                          </td>
                          <td className="py-3 font-semibold">{s.reps}</td>
                          <td className="py-3">
                            <span className={`text-xs font-mono font-medium ${s.accuracy >= 80 ? 'text-[#5B8A5A]' : 'text-[#B08A3E]'}`}>
                              {s.exercise_key === 'koi' ? '—' : `${Math.round(s.accuracy)}%`}
                            </span>
                          </td>
                          <td className="py-3 text-[#8D8777] font-mono">{s.max_streak}</td>
                          <td className="py-3 text-right font-semibold font-mono">+{s.score}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 border border-dashed border-[#E7E2D4] rounded-2xl">
                <ShieldAlert className="mx-auto text-[#B7B1A0] mb-2" size={28} />
                <p className="text-sm font-medium">No session history for this patient yet.</p>
                <p className="text-xs text-[#8D8777] mt-1">
                  Start an exercise from the plan on the right to log the first one.
                </p>
              </div>
            )}
          </div>

          {/* Patient profile + prescribed plan */}
          <div className="space-y-6">
            <div className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm">
              <p className="text-[11px] uppercase tracking-wide text-[#8D8777] mb-4">Patient profile</p>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-11 h-11 rounded-full bg-[#E8E2A8] flex items-center justify-center text-sm font-semibold text-[#6B6434]">
                  {user?.name ? user.name.slice(0, 2).toUpperCase() : 'PT'}
                </div>
                <div>
                  <p className="font-display font-semibold">{user?.name || 'Unknown patient'}</p>
                  <p className="text-xs text-[#8D8777]">ID #{user?.id ?? userId}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {user?.ailment_tags?.length > 0 ? (
                  user.ailment_tags.map((tag, idx) => (
                    <span key={idx} className="bg-[#F6F1E7] border border-[#E7E2D4] text-[#6B6450] text-xs px-2.5 py-1 rounded-full">
                      {tag.replace(/_/g, ' ')}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-[#B7B1A0] italic">No tags assigned</span>
                )}
              </div>
            </div>

            <div className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm">
              <p className="text-[11px] uppercase tracking-wide text-[#8D8777] mb-4">From your therapist</p>
              {notes.length > 0 ? (
                <ul className="space-y-3 max-h-64 overflow-y-auto">
                  {notes.map((n) => (
                    <li key={n.id} className="rounded-2xl bg-[#FBF9F3] border border-[#F0EBDD] px-4 py-3">
                      <p className="text-sm whitespace-pre-wrap break-words">{n.body}</p>
                      <p className="text-[11px] text-[#8D8777] mt-2">
                        {n.therapist_name}
                        {n.created_at && !Number.isNaN(new Date(n.created_at).getTime())
                          ? ` · ${new Date(n.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
                          : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-[#B7B1A0] italic">No notes from your therapist yet.</p>
              )}
            </div>

            <div className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <p className="text-[11px] uppercase tracking-wide text-[#8D8777]">Prescribed plan</p>
                <span className="text-xs bg-[#F6F1E7] text-[#8D8777] px-2 py-0.5 rounded-full font-mono">
                  {recommended.length}
                </span>
              </div>
              <div className="space-y-2">
                {recommended.length > 0 ? recommended.map((item, idx) => {
                  const style = exStyle(item.key);
                  return (
                    <div key={idx} className="flex items-center justify-between rounded-2xl p-3" style={{ backgroundColor: style.bg }}>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold" style={{ color: style.ink }}>#{item.priority}</span>
                          <p className="font-display text-sm font-medium" style={{ color: style.ink }}>{item.name}</p>
                        </div>
                        <p className="text-xs mt-0.5" style={{ color: style.ink, opacity: 0.75 }}>
                          {item.custom
                            ? `${item.reps_per_set} reps per set`
                            : `Start tolerance: ${item.starting_tolerance}°`}
                        </p>
                      </div>
                      <button
                        onClick={() => startExercise(item.key)}
                        className="p-2 rounded-xl bg-white/70 hover:bg-white transition-colors"
                        style={{ color: style.ink }}
                      >
                        <Play size={15} />
                      </button>
                    </div>
                  );
                }) : (
                  <p className="text-xs text-[#B7B1A0] italic">No prescribed exercises found.</p>
                )}
              </div>
            </div>
          </div>
        </div>
        </div>
      </main>
    </div>
  );
}

function StatCard({ bg, label, caption, children }) {
  return (
    <div className="rounded-3xl p-5" style={{ backgroundColor: bg }}>
      <div className="flex items-center justify-between">
        <span className="font-display text-xs font-semibold">{label}</span>
        <span className="text-[10px] uppercase tracking-wide opacity-60">{caption}</span>
      </div>
      {children}
    </div>
  );
}

// Minimal dependency-free sparkline -- no charting library required.
function Sparkline({ values, stroke }) {
  const w = 200, h = 60, pad = 4;
  const max = Math.max(...values, 100);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}