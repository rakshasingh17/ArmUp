import { useState } from 'react';
import { Send, Trash2, Loader2 } from 'lucide-react';
import { apiFetch } from './api';

// Therapist's notes for one patient: write a new one, read the earlier ones,
// delete your own. (Who may do what is enforced in the main process.)

const MAX_LEN = 1000;

function formatWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

async function errorText(res, fallback) {
  const body = await res.json().catch(() => null);
  return typeof body?.detail === 'string' ? body.detail : fallback;
}

export default function NotesCard({ patientId, therapistId, initialNotes }) {
  const [notes, setNotes] = useState(initialNotes);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [confirmId, setConfirmId] = useState(null); // note waiting for "Delete?" confirmation

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch(`/patients/${patientId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) {
        setError(await errorText(res, `Couldn't send the note (${res.status}).`));
        return;
      }
      const note = await res.json();
      setNotes((prev) => [note, ...prev]);
      setDraft('');
    } catch (err) {
      console.error(err);
      setError("Couldn't send the note. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const remove = async (id) => {
    setError(null);
    try {
      const res = await apiFetch(`/notes/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setError(await errorText(res, `Couldn't delete the note (${res.status}).`));
        return;
      }
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      console.error(err);
      setError("Couldn't delete the note. Please try again.");
    } finally {
      setConfirmId(null);
    }
  };

  return (
    <section className="bg-white border border-[#E7E2D4] rounded-3xl p-6" aria-labelledby="notes-heading">
      <h2 id="notes-heading" className="font-display font-semibold mb-1">Notes for this patient</h2>
      <p className="text-xs text-[#8D8777] mb-4">The patient sees these on their dashboard.</p>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={MAX_LEN}
        rows={3}
        placeholder="e.g. Keep your elbow tucked in during curls. Rest if it hurts."
        aria-label="New note"
        className="w-full rounded-2xl border border-[#E7E2D4] bg-[#FBF9F3] px-4 py-3 text-sm outline-none focus:border-[#17140F] resize-none"
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] text-[#B7B1A0]">{draft.length}/{MAX_LEN}</span>
        <button
          onClick={send}
          disabled={!draft.trim() || sending}
          className="flex items-center gap-2 bg-[#17140F] text-[#E9E4D6] text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-40 transition-opacity"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Send note
        </button>
      </div>

      {error && <p className="text-xs text-[#B15C7E] bg-[#F3D9E2] rounded-xl px-3 py-2 mt-3">{error}</p>}

      <ul className="mt-5 space-y-3">
        {notes.length === 0 && <li className="text-sm text-[#8D8777]">No notes yet.</li>}
        {notes.map((n) => (
          <li key={n.id} className="rounded-2xl bg-[#FBF9F3] border border-[#F0EBDD] px-4 py-3">
            <p className="text-sm whitespace-pre-wrap break-words">{n.body}</p>
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-[#8D8777]">
                {n.therapist_name} · {formatWhen(n.created_at)}
              </span>
              {n.therapist_id === therapistId &&
                (confirmId === n.id ? (
                  <span className="flex items-center gap-2 text-[11px]">
                    <button onClick={() => remove(n.id)} className="text-[#B15C7E] font-medium">Delete</button>
                    <button onClick={() => setConfirmId(null)} className="text-[#8D8777]">Cancel</button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmId(n.id)}
                    aria-label="Delete note"
                    className="text-[#B7B1A0] hover:text-[#B15C7E] transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
