/*
 * setRecorder.js
 * --------------
 * Records what is drawn on the exercise stage canvas (the camera picture with
 * the tracking skeleton on top) into a small WebM video.
 *
 *   const rec = startRecording(canvas);   // null if recording isn't possible
 *   ...
 *   const blob = await rec.stop();        // the finished video (or null)
 *   rec.cancel();                         // throw it away
 *
 * It never starts on its own: the exercise screen only calls it when the
 * patient has ticked "Allow my therapist to watch my sets".
 */

const FRAME_RATE = 24;
const BITS_PER_SECOND = 600_000;     // ~4.5 MB per minute -- small, still clear enough to judge form
const MAX_SECONDS = 4 * 60;          // safety stop; the server accepts up to 25 MB

const MIME_CHOICES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function startRecording(canvas) {
  if (typeof MediaRecorder === 'undefined' || !canvas || typeof canvas.captureStream !== 'function') return null;
  const mimeType = MIME_CHOICES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) return null;

  try {
    const stream = canvas.captureStream(FRAME_RATE);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITS_PER_SECOND });
    const chunks = [];
    let keep = true;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const finished = new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(keep && chunks.length ? new Blob(chunks, { type: 'video/webm' }) : null);
      };
      recorder.onerror = () => resolve(null);
    });
    recorder.start(1000);
    const limit = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, MAX_SECONDS * 1000);

    const end = () => {
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      return finished;
    };
    return {
      stop: end,
      cancel: () => { keep = false; end(); },
    };
  } catch (err) {
    console.error('Could not start recording:', err);
    return null;
  }
}

// Blob -> base64 text (no "data:" prefix), for sending through the app's API.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

// base64 text -> Blob, for playing a recording the server sent back.
export function base64ToBlob(base64, type = 'video/webm') {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}
