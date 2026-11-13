import { useState } from 'react';
import { Video } from 'lucide-react';
import { apiFetch } from './api';

// The patient's own switch for "my therapist may watch recordings of my sets".
// Off by default. While it is off nothing is recorded, and turning it off
// also stops the therapist from watching recordings already made.
export default function RecordingConsent({ userId, allowed, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/users/${userId}/recording-consent`, {
        method: 'PUT',
        body: JSON.stringify({ share_recordings: !allowed }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      onChange(!allowed);
    } catch (err) {
      console.error(err);
      setError("Couldn't change that setting. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-[#E7E2D4] rounded-3xl p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Video size={18} className="text-[#8D8777] mt-0.5 shrink-0" />
          <div>
            <p className="font-display text-sm font-semibold">Let my therapist watch my sets</p>
            <p className="text-xs text-[#8D8777] mt-1">
              Your camera view and tracking skeleton are recorded during a set and kept on this
              computer for 30 days. Only you and your therapist can watch. Switch off any time.
            </p>
          </div>
        </div>
        <button
          role="switch"
          aria-checked={allowed}
          aria-label="Let my therapist watch my sets"
          onClick={toggle}
          disabled={busy}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
            allowed ? 'bg-[#17140F]' : 'bg-[#D9D3C2]'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              allowed ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
      {error && <p className="text-xs text-[#B15C7E] mt-3">{error}</p>}
    </div>
  );
}
