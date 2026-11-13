import { useState, useEffect } from 'react';
import { Dumbbell, Users, LogOut, ArrowLeft, Loader2, Activity, Target, Flame, ClipboardList, ShieldAlert } from 'lucide-react';
import { apiFetch } from './api';
import InviteCodeButton from './InviteCodeButton';
import NotesCard from './NotesCard';
import PlanEditor from './PlanEditor';

// Therapist home. Separate from the patient dashboard: no camera, no
// exercises. A list of patients, and a read-only progress page for each.
// (Who may see what is enforced in the main process; GET /patients returns
// 403 to anyone who isn't a therapist.)

const EXERCISE_NAMES = {
  curl: 'Bicep Curl',
  raise: 'Lateral Raise',
  press: 'Shoulder Press',
  neck_tilt: 'Owl Neck Tilt',
};
const exerciseName = (key) => EXERCISE_NAMES[key] || key;

// Form faults the rep engine flags (FORM_RULES in engine.js). The neck tilt has
// no form rule, so its sessions show no form information.
const FAULT_LABELS = {
  elbow_drift: 'Elbow drifting',
  too_high: 'Arm too high',
  lean_back: 'Leaning back',
};
const FORM_TRACKED = new Set(['curl', 'raise', 'press']);

const prettyTag = (tag) => tag.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function TherapistDashboard({ userId, onExit }) {
  const [me, setMe] = useState(null);
  const [patients, setPatients] = useState(null); // null = still loading
  const [listError, setListError] = useState(null);

  const [selected, setSelected] = useState(null); // { id, name, loading, error, sessions }

  useEffect(() => {
    apiFetch(`/users/${userId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => {});
    apiFetch('/patients')
      .then((r) => {
        if (!r.ok) throw new Error(`Patient list failed (${r.status})`);
        return r.json();
      })
      .then(setPatients)
      .catch((err) => {
        console.error(err);
        setListError("Couldn't load your patients. Please close and reopen the app.");
        setPatients([]);
      });
  }, [userId]);

  const openPatient = async (patient) => {
    const base = { id: patient.id, name: patient.name, sessions: [], notes: [], plan: null };
    setSelected({ ...base, loading: true, error: null });
    try {
      const [sRes, nRes, pRes] = await Promise.all([
        apiFetch(`/users/${patient.id}/sessions`),
        apiFetch(`/users/${patient.id}/notes`),
        apiFetch(`/patients/${patient.id}/plan`),
      ]);
      if (!sRes.ok || !nRes.ok || !pRes.ok) {
        throw new Error(`Patient details failed (${sRes.status}/${nRes.status}/${pRes.status})`);
      }
      const [sessions, notes, plan] = await Promise.all([sRes.json(), nRes.json(), pRes.json()]);
      setSelected({ ...base, loading: false, error: null, sessions, notes, plan });
    } catch (err) {
      console.error(err);
      setSelected({ ...base, loading: false, error: "Couldn't load this patient's details." });
    }
  };

  const selectedSummary = selected && patients ? patients.find((p) => p.id === selected.id) : null;

  return (
    <div
      className="min-h-screen bg-[#F6F1E7] text-[#221E18] flex flex-col lg:flex-row"
      style={{ fontFamily: "'Inter', ui-sans-serif, sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        .font-display { font-family: 'Outfit', ui-sans-serif, sans-serif; }
      `}</style>

      <aside className="bg-[#17140F] text-[#E9E4D6] lg:w-72 lg:min-h-screen lg:m-3 lg:rounded-[2rem] p-6 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-10">
            <div className="bg-[#E8E2A8] text-[#17140F] p-2 rounded-xl">
              <Dumbbell size={20} />
            </div>
            <span className="font-display text-xl font-semibold tracking-tight">ArmUp</span>
          </div>
          <p className="text-[11px] uppercase tracking-wide text-[#8D8777] mb-3 px-1">Therapist</p>
          <button
            onClick={() => setSelected(null)}
            className="w-full font-display flex items-center gap-3 px-3 py-2 rounded-xl text-sm bg-[#E9E4D6] text-[#17140F] font-medium text-left"
          >
            <Users size={16} />
            Patients
          </button>
        </div>

        <div>
          <InviteCodeButton />
          <button
            onClick={onExit}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-[#B7B1A0] hover:bg-white/5 hover:text-[#E9E4D6] transition-colors text-left"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-8">
        {!selected ? (
          <PatientList me={me} patients={patients} error={listError} onOpen={openPatient} />
        ) : (
          <PatientDetail selected={selected} summary={selectedSummary} therapistId={userId} onBack={() => setSelected(null)} />
        )}
      </main>
    </div>
  );
}

function PatientList({ me, patients, error, onOpen }) {
  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-tight">
          {me ? `Welcome, ${me.name}` : 'Welcome'}
        </h1>
        <p className="text-sm text-[#8D8777] mt-1">
          {patients === null
            ? 'Loading your patients…'
            : `${patients.length} patient${patients.length === 1 ? '' : 's'} on ArmUp. Select one to review their progress.`}
        </p>
      </header>

      {error && <p className="text-xs text-[#B15C7E] bg-[#F3D9E2] rounded-xl px-3 py-2 mb-4 inline-block">{error}</p>}

      {patients === null ? (
        <div className="flex items-center gap-3 text-[#6B5B45]">
          <Loader2 className="animate-spin" size={20} />
          <span>Loading…</span>
        </div>
      ) : patients.length === 0 ? (
        !error && (
          <div className="bg-white border border-[#E7E2D4] rounded-3xl p-8 text-sm text-[#8D8777] max-w-md">
            No patients have signed up yet.
          </div>
        )
      ) : (
        <div className="bg-white border border-[#E7E2D4] rounded-3xl overflow-hidden">
          <div className="hidden md:grid grid-cols-[2fr_2fr_1fr_1fr_1.5fr] gap-4 px-6 py-3 text-[11px] uppercase tracking-wide text-[#8D8777] border-b border-[#E7E2D4]">
            <span>Patient</span>
            <span>Conditions</span>
            <span>Sessions</span>
            <span>Accuracy</span>
            <span>Last session</span>
          </div>
          <ul>
            {patients.map((p) => (
              <li key={p.id} className="border-b border-[#F0EBDD] last:border-b-0">
                <button
                  onClick={() => onOpen(p)}
                  className="w-full text-left grid grid-cols-2 md:grid-cols-[2fr_2fr_1fr_1fr_1.5fr] gap-x-4 gap-y-1 px-6 py-4 hover:bg-[#FBF9F3] transition-colors items-center"
                >
                  <span className="font-display font-semibold">{p.name}</span>
                  <span className="text-sm text-[#6B6450]">
                    {p.ailment_tags.length ? p.ailment_tags.map(prettyTag).join(', ') : '—'}
                  </span>
                  <span className="text-sm">{p.session_count}</span>
                  <span className="text-sm">{p.avg_accuracy === null ? '—' : `${p.avg_accuracy}%`}</span>
                  <span className="text-sm text-[#8D8777]">{formatWhen(p.last_session)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function PatientDetail({ selected, summary, therapistId, onBack }) {
  const { sessions } = selected;
  const totalReps = sessions.reduce((a, s) => a + s.reps, 0);
  const avgAccuracy = sessions.length
    ? Math.round(sessions.reduce((a, s) => a + s.accuracy, 0) / sessions.length)
    : 0;
  const bestStreak = sessions.length ? Math.max(...sessions.map((s) => s.max_streak)) : 0;
  const recent = [...sessions].reverse().slice(0, 15); // newest first

  // Form: only sessions that recorded it (older ones have form_faults = null).
  const formSessions = sessions.filter((s) => s.form_faults && FORM_TRACKED.has(s.exercise_key));
  const flagged = formSessions.filter((s) => Object.keys(s.form_faults).length > 0);
  const faultTotals = {};
  for (const s of formSessions) {
    for (const [id, n] of Object.entries(s.form_faults)) faultTotals[id] = (faultTotals[id] || 0) + n;
  }
  const topFault = Object.entries(faultTotals).sort((a, b) => b[1] - a[1])[0];

  const stats = [
    { label: 'Sessions', value: sessions.length, icon: ClipboardList },
    { label: 'Total reps', value: totalReps, icon: Activity },
    { label: 'Avg accuracy', value: `${avgAccuracy}%`, icon: Target },
    { label: 'Best streak', value: bestStreak, icon: Flame },
    {
      label: 'Sessions with form flags',
      value: formSessions.length ? `${flagged.length}/${formSessions.length}` : '—',
      icon: ShieldAlert,
      sub: topFault
        ? `Most common: ${FAULT_LABELS[topFault[0]] || topFault[0]}`
        : formSessions.length ? 'No form problems flagged' : 'No form data yet',
    },
  ];

  return (
    <>
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-[#8D8777] hover:text-[#221E18] transition-colors mb-4"
      >
        <ArrowLeft size={14} />
        All patients
      </button>

      <header className="mb-6">
        <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-tight">
          {selected.name}'s progress
        </h1>
        {summary && summary.ailment_tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {summary.ailment_tags.map((t) => (
              <span key={t} className="bg-white border border-[#E7E2D4] text-[#6B6450] text-xs px-2.5 py-1 rounded-full">
                {prettyTag(t)}
              </span>
            ))}
          </div>
        )}
      </header>

      {selected.loading ? (
        <div className="flex items-center gap-3 text-[#6B5B45]">
          <Loader2 className="animate-spin" size={20} />
          <span>Loading sessions…</span>
        </div>
      ) : selected.error ? (
        <p className="text-xs text-[#B15C7E] bg-[#F3D9E2] rounded-xl px-3 py-2 inline-block">{selected.error}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            {stats.map(({ label, value, icon: Icon, sub }) => (
              <div key={label} className="bg-white border border-[#E7E2D4] rounded-3xl p-5">
                <Icon size={18} className="text-[#8D8777] mb-3" />
                <p className="font-display text-2xl font-semibold">{value}</p>
                <p className="text-xs text-[#8D8777] mt-0.5">{label}</p>
                {sub && <p className="text-[11px] text-[#6B6450] mt-1.5">{sub}</p>}
              </div>
            ))}
          </div>

          <div className="bg-white border border-[#E7E2D4] rounded-3xl overflow-hidden">
            <h2 className="font-display font-semibold px-6 pt-5 pb-3">Recent sessions</h2>
            {recent.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-[#8D8777]">No sessions logged yet for this patient.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-[#8D8777] text-left border-y border-[#E7E2D4]">
                    <th className="px-6 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Exercise</th>
                    <th className="px-3 py-2 font-medium">Reps</th>
                    <th className="px-3 py-2 font-medium">Accuracy</th>
                    <th className="px-3 py-2 font-medium">Form</th>
                    <th className="px-6 py-2 font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((s) => (
                    <tr key={s.id} className="border-b border-[#F0EBDD] last:border-b-0">
                      <td className="px-6 py-3 text-[#6B6450]">{formatWhen(s.timestamp)}</td>
                      <td className="px-3 py-3">{exerciseName(s.exercise_key)}</td>
                      <td className="px-3 py-3">{s.reps}</td>
                      <td className="px-3 py-3">{Math.round(s.accuracy)}%</td>
                      <td className="px-3 py-3"><FormCell session={s} /></td>
                      <td className="px-6 py-3">{s.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* key = patient id, so switching patients always starts from fresh data */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-6 items-start">
            <PlanEditor key={`plan-${selected.id}`} patientId={selected.id} initialPlan={selected.plan} />
            <NotesCard
              key={`notes-${selected.id}`}
              patientId={selected.id}
              therapistId={therapistId}
              initialNotes={selected.notes}
            />
          </div>
        </>
      )}
    </>
  );
}

// "Good" = recorded with no faults; chips = faults with counts; "—" = not tracked / not recorded.
function FormCell({ session }) {
  if (!FORM_TRACKED.has(session.exercise_key) || !session.form_faults) {
    return <span className="text-[#B7B1A0]">—</span>;
  }
  const entries = Object.entries(session.form_faults);
  if (!entries.length) return <span className="text-[#2E6B4A]">Good</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([id, n]) => (
        <span key={id} className="bg-[#F3D9E2] text-[#B15C7E] text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap">
          {FAULT_LABELS[id] || id} ×{n}
        </span>
      ))}
    </span>
  );
}
