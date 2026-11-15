import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * ServerStatus -- a small connection box in the corner of the start screens.
 * Shows whether the ArmUp server is reachable (and wakes it up, since the free
 * hosting puts it to sleep when idle), and lets you change its address.
 * Renders nothing outside the desktop app.
 */
const LABELS = {
  checking: 'Connecting to server… (can take a minute)',
  ready: 'Server ready',
  down: "Can't reach server",
  none: 'Server address needed',
};
const DOT = { checking: '#E0A93B', ready: '#5E9B6B', down: '#B15C7E', none: '#B15C7E' };

export default function ServerStatus() {
  const api = typeof window !== 'undefined' ? window.armup?.server : null;
  const [state, setState] = useState('checking');
  const [url, setUrl] = useState('');
  const [detail, setDetail] = useState('');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const run = useRef(0); // ignore an old check that finishes after a newer one

  const check = useCallback(async () => {
    if (!api) return;
    const mine = ++run.current;
    setState('checking');
    setDetail('');
    const current = await api.get();
    setUrl(current);
    if (!current) {
      setState('none');
      setOpen(true);
      return;
    }
    const result = await api.ping();
    if (mine !== run.current) return;
    setState(result.ok ? 'ready' : 'down');
    setDetail(result.ok ? '' : result.detail || '');
  }, [api]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- start the first check on mount
  useEffect(() => { check(); }, [check]);

  if (!api) return null;

  const save = async (event) => {
    event.preventDefault();
    setError('');
    const result = await api.set(draft);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOpen(false);
    check();
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 text-xs">
      {open && (
        <form onSubmit={save} className="mb-2 w-72 bg-white border border-[#E7E2D4] rounded-2xl p-4 shadow-lg space-y-2">
          <p className="font-semibold text-[#3D3A2E]">Server address</p>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="your-service.onrender.com"
            className="w-full rounded-xl border border-[#E7E2D4] bg-[#FBF9F3] px-3 py-2 outline-none focus:border-[#B7B1A0]"
            aria-label="Server address"
            autoFocus
          />
          {error && <p className="text-[#B15C7E]">{error}</p>}
          {!error && detail && <p className="text-[#8D8777]">{detail}</p>}
          <div className="flex gap-2">
            <button type="submit" className="flex-1 rounded-xl bg-[#3D3A2E] text-white py-2">Save and connect</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-[#E7E2D4] px-3 py-2">Close</button>
          </div>
        </form>
      )}
      <div className="inline-flex items-center gap-2 bg-white border border-[#E7E2D4] rounded-full pl-3 pr-1.5 py-1.5 shadow-sm">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: DOT[state] }} />
        <span className="text-[#3D3A2E]">{LABELS[state]}</span>
        {state === 'down' && (
          <button type="button" onClick={check} className="rounded-full border border-[#E7E2D4] px-2 py-0.5">Retry</button>
        )}
        <button
          type="button"
          onClick={() => { setDraft(url); setError(''); setOpen((v) => !v); }}
          className="rounded-full border border-[#E7E2D4] px-2 py-0.5"
        >
          {open ? 'Hide' : 'Change'}
        </button>
      </div>
    </div>
  );
}
