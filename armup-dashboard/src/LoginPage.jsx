import React, { useState } from 'react';
import { Dumbbell, ArrowLeft, Loader2 } from 'lucide-react';

const API_BASE = "http://localhost:8000";

const INPUT_CLS =
  "w-full bg-white border border-[#E7E2D4] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#C3CE9E]";

export default function LoginPage({ onLoggedIn, onBack, onSignup }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const canSubmit = name.trim() && password && !submitting;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          typeof body?.detail === 'string' ? body.detail : `Something went wrong (${res.status}).`
        );
        return;
      }
      const user = await res.json();
      onLoggedIn(user.id);
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

        <h1 className="font-display text-2xl font-semibold tracking-tight mb-1">Welcome back</h1>
        <p className="text-sm text-[#8D8777] mb-8">
          Log in to see your sessions and pick up your exercise plan.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="login-name" className="block text-xs font-medium text-[#6B6450] mb-1.5">Name</label>
            <input
              id="login-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The name you signed up with"
              autoComplete="username"
              required
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-xs font-medium text-[#6B6450] mb-1.5">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
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
            {submitting ? 'Logging in…' : 'Log in'}
          </button>
        </form>

        <p className="text-sm text-[#8D8777] text-center mt-6">
          New here?{' '}
          <button onClick={onSignup} className="font-medium text-[#221E18] hover:underline">
            Create a profile
          </button>
        </p>
      </main>
    </div>
  );
}