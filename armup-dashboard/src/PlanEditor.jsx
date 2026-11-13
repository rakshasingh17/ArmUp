import { useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { apiFetch } from './api';

// Therapist's exercise plan for one patient: tick the exercises they should
// do and set the reps in one set. Until a plan is saved, the patient follows
// the default plan for their conditions (shown pre-ticked here).
// `initialPlan` is the answer from GET /patients/:id/plan.

const toRows = (plan) =>
  plan.exercises.map((e) => ({ key: e.key, name: e.name, enabled: e.enabled, reps: String(e.reps_per_set) }));

export default function PlanEditor({ patientId, initialPlan }) {
  const [custom, setCustom] = useState(initialPlan.custom);
  const [rows, setRows] = useState(() => toRows(initialPlan));
  const { min_reps: minReps, max_reps: maxReps } = initialPlan;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok: boolean, text: string }

  const update = (key, patch) => {
    setMessage(null);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const repsValid = (text) => /^\d+$/.test(text) && Number(text) >= minReps && Number(text) <= maxReps;
  const enabled = rows.filter((r) => r.enabled);
  const problem = !enabled.length
    ? 'Tick at least one exercise.'
    : enabled.some((r) => !repsValid(r.reps))
      ? `Reps per set must be a whole number from ${minReps} to ${maxReps}.`
      : null;

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch(`/patients/${patientId}/plan`, {
        method: 'PUT',
        body: JSON.stringify({ exercises: enabled.map((r) => ({ key: r.key, reps_per_set: Number(r.reps) })) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage({ ok: false, text: typeof body?.detail === 'string' ? body.detail : `Couldn't save (${res.status}).` });
        return;
      }
      setCustom(true);
      setMessage({ ok: true, text: 'Saved. The patient will see this plan next time their dashboard loads.' });
    } catch (err) {
      console.error(err);
      setMessage({ ok: false, text: "Couldn't save the plan. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  // Go back to the default plan from the patient's conditions.
  const reset = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const del = await apiFetch(`/patients/${patientId}/plan`, { method: 'DELETE' });
      if (!del.ok) throw new Error(`Reset failed (${del.status})`);
      const res = await apiFetch(`/patients/${patientId}/plan`);
      if (!res.ok) throw new Error(`Reload failed (${res.status})`);
      const plan = await res.json();
      setRows(toRows(plan));
      setCustom(plan.custom);
      setMessage({ ok: true, text: 'Back to the default plan for their conditions.' });
    } catch (err) {
      console.error(err);
      setMessage({ ok: false, text: "Couldn't reset the plan. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white border border-[#E7E2D4] rounded-3xl p-6" aria-labelledby="plan-heading">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 id="plan-heading" className="font-display font-semibold">Exercise plan</h2>
        <span
          className={`text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap ${
            custom ? 'bg-[#E8E2A8] text-[#17140F]' : 'bg-[#F6F1E7] text-[#8D8777]'
          }`}
        >
          {custom ? 'Custom plan' : 'Default plan'}
        </span>
      </div>
      <p className="text-xs text-[#8D8777] mb-4">
        {custom
          ? 'The patient does only the ticked exercises, with these set sizes.'
          : "Based on the patient's conditions. Change anything and save to make it a custom plan."}
      </p>

      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.key}
            className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 transition-colors ${
              r.enabled ? 'border-[#17140F] bg-[#FBF9F3]' : 'border-[#E7E2D4]'
            }`}
          >
            <label className="flex items-center gap-3 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={(e) => update(r.key, { enabled: e.target.checked })}
                className="h-4 w-4 accent-[#17140F]"
              />
              {r.name}
            </label>
            <label className="flex items-center gap-2 text-xs text-[#8D8777]">
              <input
                type="text"
                inputMode="numeric"
                value={r.reps}
                disabled={!r.enabled}
                onChange={(e) => update(r.key, { reps: e.target.value.trim() })}
                aria-label={`${r.name} reps per set`}
                className={`w-14 text-center rounded-lg border px-2 py-1 text-sm text-[#221E18] outline-none disabled:opacity-40 ${
                  r.enabled && !repsValid(r.reps) ? 'border-[#B15C7E]' : 'border-[#E7E2D4] focus:border-[#17140F]'
                }`}
              />
              reps per set
            </label>
          </li>
        ))}
      </ul>

      {problem && <p className="text-xs text-[#B15C7E] mt-3">{problem}</p>}
      {message && (
        <p
          className={`text-xs rounded-xl px-3 py-2 mt-3 flex items-center gap-1.5 ${
            message.ok ? 'text-[#2E6B4A] bg-[#DDF0E4]' : 'text-[#B15C7E] bg-[#F3D9E2]'
          }`}
        >
          {message.ok && <Check size={13} />}
          {message.text}
        </p>
      )}

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={save}
          disabled={!!problem || busy}
          className="flex items-center gap-2 bg-[#17140F] text-[#E9E4D6] text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-40 transition-opacity"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Save plan
        </button>
        {custom && (
          <button
            onClick={reset}
            disabled={busy}
            className="text-sm text-[#8D8777] hover:text-[#221E18] transition-colors disabled:opacity-40"
          >
            Reset to default
          </button>
        )}
      </div>
    </section>
  );
}
