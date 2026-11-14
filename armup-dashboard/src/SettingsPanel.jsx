import { useEffect } from 'react';
import { X } from 'lucide-react';
import { TEXT_SIZES } from './displaySettings';

// Patient settings dialog. Changes apply immediately and are saved by the
// parent; there is no separate Save button to forget to press.
export default function SettingsPanel({ settings, onChange, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-full max-w-md rounded-3xl bg-[#F6F1E7] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display text-xl font-semibold">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-2 rounded-full hover:bg-black/5"
          >
            <X size={18} />
          </button>
        </div>

        <p className="font-display text-sm font-medium mb-2">Text size</p>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {TEXT_SIZES.map((t) => (
            <button
              key={t.key}
              onClick={() => onChange({ ...settings, textSize: t.key })}
              aria-pressed={settings.textSize === t.key}
              className={`font-display text-sm px-3 py-2 rounded-xl transition-colors ${
                settings.textSize === t.key
                  ? 'bg-[#17140F] text-[#E9E4D6]'
                  : 'bg-white border border-[#E7E2D4] text-[#6B5B45]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-[#6B5B45] mb-6">
          Makes all text, buttons and cards bigger across the dashboard.
        </p>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.highContrast}
            onChange={(e) => onChange({ ...settings, highContrast: e.target.checked })}
            className="mt-1 h-5 w-5 accent-[#17140F]"
          />
          <span>
            <span className="font-display text-sm font-medium block">Darker text</span>
            <span className="text-sm text-[#6B5B45]">
              Turns the light grey captions and labels dark so they are easier to read.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
