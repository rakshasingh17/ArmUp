import { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { apiFetch } from './api';
import { base64ToBlob } from './setRecorder';

// Plays one recorded set in a pop-up. The video is fetched from the main
// process only when the therapist clicks Watch, and kept in memory, not on disk.
export default function RecordingPlayer({ sessionId, title, onClose }) {
  const [state, setState] = useState({ loading: true, url: null, error: null });

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/sessions/${sessionId}/recording`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(typeof body?.detail === 'string' ? body.detail : `Couldn't load the video (${res.status}).`);
        }
        const { data, mime } = await res.json();
        objectUrl = URL.createObjectURL(base64ToBlob(data, mime));
        if (!cancelled) setState({ loading: false, url: objectUrl, error: null });
      } catch (err) {
        console.error(err);
        if (!cancelled) setState({ loading: false, url: null, error: err.message || "Couldn't load the video." });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Recorded set"
    >
      <div className="bg-[#F6F1E7] rounded-3xl p-5 w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#8D8777] hover:text-[#221E18] transition-colors">
            <X size={18} />
          </button>
        </div>
        {state.loading && (
          <div className="flex items-center gap-3 text-[#6B5B45] py-16 justify-center">
            <Loader2 className="animate-spin" size={20} />
            <span>Loading video…</span>
          </div>
        )}
        {state.error && (
          <p className="text-sm text-[#B15C7E] bg-[#F3D9E2] rounded-xl px-4 py-3">{state.error}</p>
        )}
        {state.url && (
          <video src={state.url} controls autoPlay className="w-full rounded-2xl bg-black" />
        )}
      </div>
    </div>
  );
}
