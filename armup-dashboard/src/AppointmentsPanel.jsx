import { useEffect, useState } from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import { apiFetch } from './api';

// Appointments for both sides of ArmUp.
//
//   role="patient"                 the patient's own list + "request an appointment"
//   role="therapist" patient={p}   one patient's appointments + "book an appointment"
//   role="therapist"               all of this therapist's appointments, requests first
//
// A status of "requested" always means it is the THERAPIST's turn to answer;
// "scheduled" means it is the PATIENT's turn to confirm. (Who may do what is
// enforced in the main process, electron/appointments.cjs; the buttons here
// just match it.)

const MAX_NOTE = 300;
const LENGTHS = [15, 30, 45, 60];
const OPEN = ['requested', 'scheduled', 'confirmed'];

function whenText(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// Earliest value the date picker allows: right now, in the computer's own time.
function pickerMin() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// "2026-11-20T10:30" (local time from the picker) -> an exact moment in UTC.
function toIso(local) {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

async function errorText(res, fallback) {
  const body = await res.json().catch(() => null);
  return typeof body?.detail === 'string' ? body.detail : fallback;
}

const needsMe = (role, a) =>
  (role === 'patient' && a.status === 'scheduled') || (role === 'therapist' && a.status === 'requested');

function statusInfo(role, a) {
  switch (a.status) {
    case 'requested':
      return role === 'therapist'
        ? { label: 'Needs your approval', bg: '#E8E2A8', ink: '#6B6434' }
        : { label: `Waiting for ${a.therapist_name}`, bg: '#EFEAE0', ink: '#6B6450' };
    case 'scheduled':
      return role === 'patient'
        ? { label: 'Please confirm', bg: '#E8E2A8', ink: '#6B6434' }
        : { label: 'Waiting for patient', bg: '#EFEAE0', ink: '#6B6450' };
    case 'confirmed': return { label: 'Confirmed', bg: '#D5E6D3', ink: '#3F6B3E' };
    case 'completed': return { label: 'Completed', bg: '#CFE1EC', ink: '#3E7396' };
    case 'declined': return { label: 'Declined', bg: '#F3D9E2', ink: '#8A4E68' };
    default: return { label: 'Cancelled', bg: '#F3D9E2', ink: '#8A4E68' };
  }
}

// Which buttons each side sees for an open appointment.
function actionsFor(role, a) {
  const started = new Date(a.starts_at) <= new Date();
  if (role === 'patient') {
    if (a.status === 'scheduled') return ['confirm', 'reschedule', 'cancel'];
    return ['reschedule', 'cancel'];
  }
  if (a.status === 'requested') return ['approve', 'decline', 'reschedule'];
  if (a.status === 'scheduled') return ['reschedule', 'cancel'];
  return started ? ['complete', 'reschedule', 'cancel'] : ['reschedule', 'cancel'];
}

const LABELS = {
  confirm: 'Confirm', approve: 'Approve', decline: 'Decline', complete: 'Mark completed',
  cancel: 'Cancel', reschedule: 'Change time',
};

function Row({ a, role, showName, onAct }) {
  const [mode, setMode] = useState(null); // null | 'reschedule' | 'sure:<action>'
  const [when, setWhen] = useState('');
  const [working, setWorking] = useState(false);
  const info = statusInfo(role, a);
  const open = OPEN.includes(a.status);
  const who = role === 'patient' ? a.therapist_name : a.patient_name;

  const run = async (action, body) => {
    setWorking(true);
    const failed = await onAct(a.id, action, body);
    setWorking(false);
    if (!failed) setMode(null);
  };

  const click = (action) => {
    if (action === 'reschedule') setMode('reschedule');
    else if (action === 'cancel' || action === 'decline') setMode(`sure:${action}`);
    else run(action);
  };

  return (
    <li
      className={`rounded-2xl border px-4 py-3 ${
        needsMe(role, a) ? 'bg-[#FBF7E3] border-[#E8E2A8]' : 'bg-[#FBF9F3] border-[#F0EBDD]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{whenText(a.starts_at)}</p>
          <p className="text-xs text-[#8D8777] mt-0.5">
            {a.duration_min} min{showName && who ? ` · ${who}` : ''}
          </p>
        </div>
        <span
          className="shrink-0 text-[11px] font-medium px-2.5 py-1 rounded-full"
          style={{ backgroundColor: info.bg, color: info.ink }}
        >
          {info.label}
        </span>
      </div>

      {a.note && <p className="text-sm text-[#6B6450] mt-2 whitespace-pre-wrap break-words">{a.note}</p>}

      {open && mode === null && (
        <div className="flex flex-wrap gap-2 mt-3">
          {actionsFor(role, a).map((action) => (
            <button
              key={action}
              onClick={() => click(action)}
              disabled={working}
              className={`text-xs font-medium px-3 py-1.5 rounded-xl transition-colors disabled:opacity-40 ${
                action === 'confirm' || action === 'approve'
                  ? 'bg-[#17140F] text-[#E9E4D6]'
                  : 'bg-white border border-[#E7E2D4] text-[#6B6450] hover:border-[#17140F]'
              }`}
            >
              {action === 'cancel' && role === 'patient' && a.status === 'requested'
                ? 'Cancel request'
                : action === 'reschedule' && role === 'patient'
                  ? 'Suggest new time'
                  : LABELS[action]}
            </button>
          ))}
        </div>
      )}

      {mode === 'reschedule' && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-[#8D8777]">
            New date and time
            <input
              type="datetime-local"
              value={when}
              min={pickerMin()}
              onChange={(e) => setWhen(e.target.value)}
              className="block mt-1 rounded-xl border border-[#E7E2D4] bg-white px-3 py-1.5 text-sm outline-none focus:border-[#17140F]"
            />
          </label>
          <button
            onClick={() => run('reschedule', { starts_at: toIso(when) })}
            disabled={!when || working}
            className="text-xs font-medium px-3 py-2 rounded-xl bg-[#17140F] text-[#E9E4D6] disabled:opacity-40"
          >
            {role === 'patient' ? 'Send suggestion' : 'Save new time'}
          </button>
          <button onClick={() => setMode(null)} className="text-xs text-[#8D8777] px-2 py-2">Keep as is</button>
        </div>
      )}

      {mode?.startsWith('sure:') && (
        <div className="mt-3 flex items-center gap-3 text-xs">
          <span className="text-[#6B6450]">
            {mode === 'sure:decline' ? 'Decline this request?' : 'Cancel this appointment?'}
          </span>
          <button
            onClick={() => run(mode.slice(5))}
            disabled={working}
            className="text-[#B15C7E] font-medium disabled:opacity-40"
          >
            Yes
          </button>
          <button onClick={() => setMode(null)} className="text-[#8D8777]">No</button>
        </div>
      )}
    </li>
  );
}

export default function AppointmentsPanel({ role, patient = null }) {
  const [appts, setAppts] = useState(null); // null = still loading
  const [therapists, setTherapists] = useState([]);
  const [error, setError] = useState(null);

  // form
  const [therapistId, setTherapistId] = useState('');
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const patientId = patient?.id; // a number, so it is safe in the dependency list below
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  // Fetches the list on first show and again whenever reload() is called.
  useEffect(() => {
    let alive = true;
    apiFetch('/appointments')
      .then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.json();
      })
      .then((all) => {
        if (alive) setAppts(patientId ? all.filter((a) => a.patient_id === patientId) : all);
      })
      .catch((err) => {
        console.error(err);
        if (alive) {
          setError("Couldn't load appointments.");
          setAppts((prev) => prev ?? []);
        }
      });
    return () => { alive = false; };
  }, [patientId, tick]);

  useEffect(() => {
    if (role !== 'patient') return;
    apiFetch('/therapists')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        setTherapists(list);
        setTherapistId((cur) => cur || (list[0] ? String(list[0].id) : ''));
      })
      .catch(() => {});
  }, [role]);

  // Returns an error message, or null when it worked.
  const act = async (id, action, body) => {
    setError(null);
    try {
      const res = await apiFetch(`/appointments/${id}/${action}`, { method: 'POST', body: JSON.stringify(body || {}) });
      if (!res.ok) {
        const msg = await errorText(res, "That didn't work. Please try again.");
        setError(msg);
        reload(); // the other person may have changed it meanwhile
        return msg;
      }
      reload();
      return null;
    } catch (err) {
      console.error(err);
      setError("That didn't work. Please try again.");
      return 'failed';
    }
  };

  const submit = async () => {
    setError(null);
    setSent(false);
    setSending(true);
    try {
      const payload = { starts_at: toIso(when), duration_min: minutes, note: note.trim() };
      if (role === 'patient') payload.therapist_id = Number(therapistId);
      else payload.patient_id = patientId;
      const res = await apiFetch('/appointments', { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) {
        setError(await errorText(res, "Couldn't save the appointment. Please try again."));
        return;
      }
      setWhen('');
      setNote('');
      setSent(true);
      reload();
    } catch (err) {
      console.error(err);
      setError("Couldn't save the appointment. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const canBook = role === 'patient' || !!patient;
  const open = (appts || []).filter((a) => OPEN.includes(a.status));
  // Requests waiting on this person come first.
  const ordered = [...open].sort((a, b) => Number(needsMe(role, b)) - Number(needsMe(role, a)));
  const earlier = (appts || []).filter((a) => !OPEN.includes(a.status)).reverse().slice(0, 5);
  const waiting = open.filter((a) => needsMe(role, a)).length;
  const showName = role === 'patient' || !patient;

  return (
    <section className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm" aria-labelledby={`appts-${role}`}>
      <div className="flex items-center justify-between mb-1">
        <h2 id={`appts-${role}`} className="font-display font-semibold flex items-center gap-2">
          <CalendarDays size={16} />
          {patient ? `Appointments with ${patient.name}` : 'Appointments'}
        </h2>
        {waiting > 0 && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#E8E2A8] text-[#6B6434]">
            {waiting} waiting
          </span>
        )}
      </div>
      <p className="text-xs text-[#8D8777] mb-4">
        {role === 'patient'
          ? 'Your therapist can book a time for you, or you can request one.'
          : patient
            ? 'The patient confirms times you book. You approve times they request.'
            : 'Requests from your patients appear here. Open a patient to book a time for them.'}
      </p>

      {appts === null ? (
        <p className="text-sm text-[#8D8777] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p>
      ) : (
        <>
          <ul className="space-y-3">
            {ordered.length === 0 && <li className="text-sm text-[#8D8777]">No upcoming appointments.</li>}
            {ordered.map((a) => (
              <Row key={`${a.id}-${a.status}-${a.starts_at}`} a={a} role={role} showName={showName} onAct={act} />
            ))}
          </ul>

          {earlier.length > 0 && (
            <details className="mt-4">
              <summary className="text-xs text-[#8D8777] cursor-pointer">Earlier ({earlier.length})</summary>
              <ul className="space-y-3 mt-3">
                {earlier.map((a) => (
                  <Row key={`${a.id}-${a.status}`} a={a} role={role} showName={showName} onAct={act} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {error && <p className="text-xs text-[#B15C7E] bg-[#F3D9E2] rounded-xl px-3 py-2 mt-4">{error}</p>}

      {canBook && (
        <div className="mt-5 pt-4 border-t border-[#F0EBDD]">
          <p className="font-display text-sm font-medium mb-3">
            {role === 'patient' ? 'Request an appointment' : 'Book an appointment'}
          </p>

          {role === 'patient' && therapists.length === 0 ? (
            <p className="text-xs text-[#8D8777]">No therapists are on ArmUp yet.</p>
          ) : (
            <div className="space-y-3">
              {role === 'patient' && (
                <label className="block text-xs text-[#8D8777]">
                  Therapist
                  <select
                    value={therapistId}
                    onChange={(e) => setTherapistId(e.target.value)}
                    className="block w-full mt-1 rounded-xl border border-[#E7E2D4] bg-[#FBF9F3] px-3 py-2 text-sm text-[#221E18] outline-none focus:border-[#17140F]"
                  >
                    {therapists.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              )}
              <div className="flex flex-wrap gap-3">
                <label className="block text-xs text-[#8D8777] flex-1 min-w-[11rem]">
                  Date and time
                  <input
                    type="datetime-local"
                    value={when}
                    min={pickerMin()}
                    onChange={(e) => { setWhen(e.target.value); setSent(false); }}
                    className="block w-full mt-1 rounded-xl border border-[#E7E2D4] bg-[#FBF9F3] px-3 py-2 text-sm text-[#221E18] outline-none focus:border-[#17140F]"
                  />
                </label>
                <label className="block text-xs text-[#8D8777]">
                  Length
                  <select
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                    className="block mt-1 rounded-xl border border-[#E7E2D4] bg-[#FBF9F3] px-3 py-2 text-sm text-[#221E18] outline-none focus:border-[#17140F]"
                  >
                    {LENGTHS.map((m) => <option key={m} value={m}>{m} min</option>)}
                  </select>
                </label>
              </div>
              <label className="block text-xs text-[#8D8777]">
                Note (optional)
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={MAX_NOTE}
                  rows={2}
                  placeholder={role === 'patient' ? 'e.g. My shoulder feels tighter this week' : 'e.g. Bring your elbow brace'}
                  className="block w-full mt-1 rounded-xl border border-[#E7E2D4] bg-[#FBF9F3] px-3 py-2 text-sm text-[#221E18] outline-none focus:border-[#17140F] resize-none"
                />
              </label>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#B7B1A0]">{sent ? (role === 'patient' ? 'Request sent.' : 'Booked. The patient will see it.') : ''}</span>
                <button
                  onClick={submit}
                  disabled={!when || sending || (role === 'patient' && !therapistId)}
                  className="flex items-center gap-2 bg-[#17140F] text-[#E9E4D6] text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-40"
                >
                  {sending && <Loader2 size={14} className="animate-spin" />}
                  {role === 'patient' ? 'Send request' : 'Book'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
