// Per-patient display settings (text size, stronger text colour).
// Stored in the browser's localStorage on this computer, keyed by user id,
// so each patient who logs in on a shared PC keeps their own choices.

export const TEXT_SIZES = [
  { key: 'normal', label: 'Normal', scale: 1 },
  { key: 'large', label: 'Large', scale: 1.15 },
  { key: 'xlarge', label: 'Extra large', scale: 1.3 },
];

export const DEFAULT_SETTINGS = { textSize: 'normal', highContrast: false };

const storageKey = (userId) => `armup.display.${userId}`;

export function loadSettings(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      textSize: TEXT_SIZES.some((t) => t.key === parsed.textSize) ? parsed.textSize : DEFAULT_SETTINGS.textSize,
      highContrast: parsed.highContrast === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(userId, settings) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(settings));
  } catch {
    /* storage unavailable: the setting still applies for this session */
  }
}

// Tailwind sizes everything in rem, so scaling the root font size scales
// the whole dashboard (text, buttons, spacing) together.
export function applySettings(settings) {
  const root = document.documentElement;
  const scale = (TEXT_SIZES.find((t) => t.key === settings.textSize) || TEXT_SIZES[0]).scale;
  root.style.fontSize = scale === 1 ? '' : `${scale * 100}%`;
  root.classList.toggle('armup-high-contrast', !!settings.highContrast);
}

export function clearSettings() {
  const root = document.documentElement;
  root.style.fontSize = '';
  root.classList.remove('armup-high-contrast');
}
