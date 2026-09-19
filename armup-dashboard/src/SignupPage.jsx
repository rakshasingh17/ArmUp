import React, { useState, useEffect, useRef } from 'react';
import { Dumbbell, ArrowLeft, Loader2, ChevronDown, Check, X } from 'lucide-react';

const API_BASE = "http://localhost:8000";
const MIN_PASSWORD_LEN = 6; // keep in sync with MIN_PASSWORD_LEN in armup_api.py

const INPUT_CLS =
  "w-full bg-white border border-[#E7E2D4] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#C3CE9E]";

export default function SignupPage({ onCreated, onBack, onLogin }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [conditions, setConditions] = useState([]); // [{ tag, label, exercises: [names] }]
  const [loadingConditions, setLoadingConditions] = useState(true);
  const [conditionsFailed, setConditionsFailed] = useState(false);
  const [selected, setSelected] = useState([]); // selected tags
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/conditions`)
      .then((r) => {
        if (!r.ok) throw new Error(`Backend responded ${r.status}`);
        return r.json();
      })
      .then(setConditions)
      .catch((err) => {
        console.error(err);
        setConditionsFailed(true);
      })
      .finally(() => setLoadingConditions(false));
  }, []);

  const toggleCondition = (tag) =>
    setSelected((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  // Preview of the plan the backend will build from these conditions.
  const planNames = [
    ...new Set(conditions.filter((c) => selected.includes(c.tag)).flatMap((c) => c.exercises)),
  ];

  const canSubmit =
    name.trim() && password && confirm && selected.length > 0 && !submitting;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    if (password.length < MIN_PASSWORD_LEN) {
      setError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), password, ailment_tags: selected }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          typeof body?.detail === 'string' ? body.detail : `Something went wrong (${res.status}).`
        );
        return;
      }
      const user = await res.json();
      onCreated(user.id);
    } catch (err) {
      setError("Couldn't reach the backend. Make sure uvicorn is running on port 8000, then try again.");
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen bg-[#F6F1E7] text-[#221E18] flex flex-col items-center"
      style={{ fontFamily: "'Inter', ui-sans-serif, sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        .font-display { font-family: 'Outfit', ui-sans-serif, sans-serif; }
      `}</style>

      <div className="w-full max-w-md px-6 pt-8">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-[#8D8777] hover:text-[#221E18] transition-colors">
          <ArrowLeft size={14} />
          Back
        </button>
      </div>

      <main className="w-full max-w-md px-6 pt-8 pb-16">
        <div className="flex items-center gap-2 mb-8">
          <div className="bg-[#E8E2A8] text-[#17140F] p-1.5 rounded-lg">
            <Dumbbell size={18} />
          </div>
          <span className="font-display text-lg font-semibold tracking-tight">ArmUp</span>
        </div>

        <h1 className="font-display text-2xl font-semibold tracking-tight mb-1">Create your profile</h1>
        <p className="text-sm text-[#8D8777] mb-8">
          Tell us what you're recovering from and we'll set up your exercise plan.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="signup-name" className="block text-xs font-medium text-[#6B6450] mb-1.5">Name</label>
            <input
              id="signup-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              autoComplete="username"
              required
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#6B6450] mb-1.5">
              Conditions <span className="font-normal text-[#B7B1A0]">(pick all that apply)</span>
            </label>
            <ConditionPicker
              options={conditions}
              selected={selected}
              onToggle={toggleCondition}
              loading={loadingConditions}
              failed={conditionsFailed}
            />

            {selected.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {selected.map((tag) => {
                  const cond = conditions.find((c) => c.tag === tag);
                  return (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1.5 bg-white border border-[#E7E2D4] text-[#6B6450] text-xs pl-2.5 pr-1.5 py-1 rounded-full"
                    >
                      {cond ? cond.label : tag}
                      <button
                        type="button"
                        onClick={() => toggleCondition(tag)}
                        aria-label={`Remove ${cond ? cond.label : tag}`}
                        className="text-[#B7B1A0] hover:text-[#221E18] transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {planNames.length > 0 && (
              <div className="mt-3 rounded-2xl bg-[#E8E2A8]/50 px-4 py-3">
                <p className="text-xs font-medium text-[#6B6434] mb-1.5">Your plan will include</p>
                <div className="flex flex-wrap gap-2">
                  {planNames.map((n) => (
                    <span key={n} className="bg-white/70 text-[#6B6434] text-xs font-medium px-2.5 py-1 rounded-full">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="signup-password" className="block text-xs font-medium text-[#6B6450] mb-1.5">
              Password <span className="font-normal text-[#B7B1A0]">(at least {MIN_PASSWORD_LEN} characters)</span>
            </label>
            <input
              id="signup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="signup-confirm" className="block text-xs font-medium text-[#6B6450] mb-1.5">Confirm password</label>
            <input
              id="signup-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              className={INPUT_CLS}
            />
          </div>

          {error && (
            <p className="text-xs text-[#B15C7E] bg-[#F3D9E2] rounded-xl px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="font-display w-full flex items-center justify-center gap-2 bg-[#17140F] text-[#E9E4D6] px-6 py-3 rounded-2xl font-medium hover:bg-[#221E18] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {submitting ? 'Creating profile…' : 'Create profile & continue'}
          </button>
        </form>

        {onLogin && (
          <p className="text-sm text-[#8D8777] text-center mt-6">
            Already have an account?{' '}
            <button onClick={onLogin} className="font-medium text-[#221E18] hover:underline">
              Log in
            </button>
          </p>
        )}
      </main>
    </div>
  );
}

// Multi-select dropdown: stays open while you tick several conditions,
// closes on outside click.
function ConditionPicker({ options, selected, onToggle, loading, failed }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  let label = 'Select your conditions';
  if (loading) label = 'Loading conditions…';
  else if (failed) label = 'Conditions unavailable';
  else if (selected.length > 0) label = `${selected.length} selected`;

  const muted = loading || failed || selected.length === 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={loading || failed}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between bg-white border border-[#E7E2D4] rounded-xl px-4 py-2.5 text-sm text-left focus:outline-none focus:ring-2 focus:ring-[#C3CE9E] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <span className={muted ? 'text-[#9CA3AF]' : ''}>{label}</span>
        <ChevronDown
          size={16}
          className={`text-[#8D8777] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {failed && (
        <p className="text-xs text-[#B15C7E] mt-2">
          Couldn't load conditions. Make sure uvicorn is running on port 8000, then refresh.
        </p>
      )}

      {open && (
        <ul
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-10 mt-2 w-full bg-white border border-[#E7E2D4] rounded-2xl shadow-lg p-1.5 max-h-64 overflow-y-auto"
        >
          {options.map((opt) => {
            const isOn = selected.includes(opt.tag);
            return (
              <li key={opt.tag} role="option" aria-selected={isOn}>
                <button
                  type="button"
                  onClick={() => onToggle(opt.tag)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-left hover:bg-[#F6F1E7] transition-colors"
                >
                  <span
                    className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${
                      isOn ? 'bg-[#17140F] border-[#17140F] text-[#E9E4D6]' : 'border-[#D5CFBF]'
                    }`}
                  >
                    {isOn && <Check size={12} />}
                  </span>
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}