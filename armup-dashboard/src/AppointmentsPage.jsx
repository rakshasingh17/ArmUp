import { useEffect, useState } from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import { apiFetch } from './api';
import { needsMe, countWaiting } from './appointmentUtils';

// The Appointments page, for both sides of ArmUp. It has its own entry in the
// left-hand menu.
//
//   role="patient"     the patient's own appointments + "Request an appointment"
//   role="therapist"   all of this therapist's appointments + "Book an appointment"
//                      (the therapist picks one of their `patients`)
//
// A status of "requested" always means it is the THERAPIST's turn to answer;
// "scheduled" means it is the PATIENT's turn to confirm. (Who may do what is
// enforced in the main process, electron/appointments.cjs; the buttons here
// just match it.)

const MAX_NOTE = 300;
const LENGTHS = [15, 30, 45, 60];
const OPEN = ['requested', 'scheduled', 'confirmed'];
const EARLIER_SHOWN = 10;

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

function Row({ a, role, onAct }) {
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
            {a.duration_min} min{who ? ` · ${who}` : ''}
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

// The title of one block of appointments, with how many are in it.
function GroupTitle({ children, count }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="font-display text-sm font-semibold">{children}</h2>
      <span className="text-[11px] font-mono bg-[#F6F1E7] text-[#8D8777] px-2 py-0.5 rounded-full">{count}</span>
    </div>
  );
}

// `patients` is only used by therapists (the people they can book).
// `preselectPatientId` opens the booking form for that patient.
// `onWaitingChange(n)` tells the menu how many are waiting on this person.
export default function AppointmentsPage({ role, patients = [], preselectPatientId = null, onWaitingChange }) {
  const [appts, setAppts] = useState(null); // null = still loading
  const [therapists, setTherapists] = useState([]);
  const [error, setError] = useState(null);

  // form
  const [therapistId, setTherapistId] = useState('');
  const [patientId, setPatientId] = useState(preselectPatientId ? String(preselectPatientId) : '');
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

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
        if (!alive) return;
        setAppts(all);
        onWaitingChange?.(countWaiting(role, all));
      })
      .catch((err) => {
        console.error(err);
        if (alive) {
          setError("Couldn't load appointments.");
          setAppts((prev) => prev ?? []);
        }
      });
    return () => { alive = false; };
    // onWaitingChange is deliberately left out: it only reports a number upwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, tick]);

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
      else payload.patient_id = Number(patientId);
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

  const isPatient = role === 'patient';
  const open = (appts || []).filter((a) => OPEN.includes(a.status));
  const waitingOnMe = open.filter((a) => needsMe(role, a));
  const otherOpen = open.filter((a) => !needsMe(role, a));
  const earlier = (appts || []).filter((a) => !OPEN.includes(a.status)).reverse().slice(0, EARLIER_SHOWN);

  const noPeople = isPatient ? therapists.length === 0 : patients.length === 0;
  const canSend = !!when && !sending && (isPatient ? !!therapistId : !!patientId);
  const fieldClass =
    'block w-full mt-1 rounded-xl border border-[#E7E2D4] bg-[#FBF9F3] px-3 py-2 text-sm text-[#221E18] outline-none focus:border-[#17140F]';

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-tight flex items-center gap-3">
          <CalendarDays size={26} />
          Appointments
        </h1>
        <p className="text-sm text-[#8D8777] mt-1 max-w-xl">
          {isPatient
            ? 'Your therapist can book a time for you, or you can request one. Either of you can suggest a new time, and the other agrees to it.'
            : 'Book a time for a patient and they confirm it, or approve the times they request. Either of you can suggest a new time, and the other agrees to it.'}
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_24rem] gap-6 items-start">
        {/* Appointment lists */}
        <div className="space-y-6">
          {appts === null ? (
            <p className="text-sm text-[#8D8777] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p>
          ) : (
            <>
              {error && <p className="text-xs text-[#B15C7E] bg-[#F3D9E2] rounded-xl px-3 py-2">{error}</p>}

              {waitingOnMe.length > 0 && (
                <section className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm">
                  <GroupTitle count={waitingOnMe.length}>{isPatient ? 'Please confirm' : 'Needs your reply'}</GroupTitle>
                  <ul className="space-y-3">
                    {waitingOnMe.map((a) => (
                      <Row key={`${a.id}-${a.status}-${a.starts_at}`} a={a} role={role} onAct={act} />
                    ))}
                  </ul>
                </section>
              )}

              <section className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm">
                <GroupTitle count={otherOpen.length}>Upcoming</GroupTitle>
                {otherOpen.length === 0 ? (
                  <p className="text-sm text-[#8D8777]">
                    {waitingOnMe.length > 0 ? 'Nothing else coming up.' : 'No upcoming appointments.'}
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {otherOpen.map((a) => (
                      <Row key={`${a.id}-${a.status}-${a.starts_at}`} a={a} role={role} onAct={act} />
                    ))}
                  </ul>
                )}
              </section>

              {earlier.length > 0 && (
                <section className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm">
                  <details>
                    <summary className="font-display text-sm font-semibold cursor-pointer">
                      Earlier <span className="text-[11px] font-mono bg-[#F6F1E7] text-[#8D8777] px-2 py-0.5 rounded-full ml-1">{earlier.length}</span>
                    </summary>
                    <ul className="space-y-3 mt-3">
                      {earlier.map((a) => (
                        <Row key={`${a.id}-${a.status}`} a={a} role={role} onAct={act} />
                      ))}
                    </ul>
                  </details>
                </section>
              )}
            </>
          )}
        </div>

        {/* Booking form */}
        <section className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm xl:sticky xl:top-6" aria-labelledby="appt-form-title">
          <h2 id="appt-form-title" className="font-display font-semibold mb-4">
            {isPatient ? 'Request an appointment' : 'Book an appointment'}
          </h2>

          {noPeople ? (
            <p className="text-xs text-[#8D8777]">
              {isPatient ? 'No therapists are on ArmUp yet.' : 'No patients have signed up yet.'}
            </p>
          ) : (
            <div className="space-y-3">
              {isPatient ? (
                <label className="block text-xs text-[#8D8777]">
                  Therapist
                  <select value={therapistId} onChange={(e) => setTherapistId(e.target.value)} className={fieldClass}>
                    {therapists.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              ) : (
                <label className="block text-xs text-[#8D8777]">
                  Patient
                  <select
                    value={patientId}
                    onChange={(e) => { setPatientId(e.target.value); setSent(false); }}
                    className={fieldClass}
                  >
                    <option value="">Choose a patient…</option>
                    {patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
                    className={fieldClass}
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
                  rows={3}
                  placeholder={isPatient ? 'e.g. My shoulder feels tighter this week' : 'e.g. Bring your elbow brace'}
                  className={`${fieldClass} resize-none`}
                />
              </label>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#8D8777]">
                  {sent ? (isPatient ? 'Request sent.' : 'Booked. The patient will see it.') : ''}
                </span>
                <button
                  onClick={submit}
                  disabled={!canSend}
                  className="flex items-center gap-2 bg-[#17140F] text-[#E9E4D6] text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-40"
                >
                  {sending && <Loader2 size={14} className="animate-spin" />}
                  {isPatient ? 'Send request' : 'Book'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
