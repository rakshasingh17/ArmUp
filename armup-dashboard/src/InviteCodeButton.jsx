import { useState } from 'react';
import { KeyRound, Copy, Check, Loader2 } from 'lucide-react';
import { apiFetch } from './api';

// Therapist-only. Asks the main process for a new single-use invite code and
// shows it once. The real "therapists only" check is in the main process
// (POST /invites returns 403 for patients); this button just isn't shown to them.
export default function InviteCodeButton() {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await apiFetch('/invites', { method: 'POST', body: '{}' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setCode(null);
        setError(typeof body?.detail === 'string' ? body.detail : `Something went wrong (${res.status}).`);
        return;
      }
      setCode((await res.json()).code);
    } catch (err) {
      console.error(err);
      setCode(null);
      setError("Couldn't create a code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard blocked -- the code is still on screen to copy by hand.
    }
  };

  return (
    <div className="mb-2">
      <button
        onClick={create}
        disabled={busy}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-[#B7B1A0] hover:bg-white/5 hover:text-[#E9E4D6] transition-colors text-left disabled:opacity-60"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
        Create invite code
      </button>

      {code && (
        <div className="mx-1 mt-1 rounded-xl bg-white/5 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-[#8D8777] mb-1">
            Single-use therapist code
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-[#E9E4D6] select-all">{code}</span>
            <button
              onClick={copy}
              aria-label="Copy invite code"
              className="text-[#B7B1A0] hover:text-[#E9E4D6] transition-colors"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <p className="text-[10px] text-[#8D8777] mt-1.5">Shown once. Give it to the therapist you're inviting.</p>
        </div>
      )}

      {error && <p className="mx-1 mt-1 text-[11px] text-[#F3D9E2]">{error}</p>}
    </div>
  );
}
