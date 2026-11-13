/*
 * recordings.cjs -- where set recordings live on disk
 * ---------------------------------------------------
 * One small .webm file per session, in a "recordings" folder inside the app's
 * data folder (next to armup.db). Nothing here is reachable from the web page
 * directly; the page goes through the routes in routes.cjs, which check who is
 * asking and whether the patient has agreed to be recorded.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 25 * 1024 * 1024; // a few minutes of 600 kbps video is ~18 MB
const RETENTION_DAYS = 30;

let dir = null;

function initRecordings(recordingsDir) {
  fs.mkdirSync(recordingsDir, { recursive: true });
  dir = recordingsDir;
}

// Session ids are integers, so a file name can never escape the folder.
const fileFor = (sessionId) => path.join(dir, `session-${Number(sessionId)}.webm`);

// A WebM/Matroska file starts with the EBML header 1A 45 DF A3.
const looksLikeWebm = (buf) =>
  buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;

// base64 text from the page -> a checked Buffer, or { error }.
function decodeUpload(base64) {
  if (typeof base64 !== 'string' || !base64.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { error: 'No video data.' };
  }
  if (Math.floor((base64.length * 3) / 4) > MAX_BYTES) return { error: 'That recording is too large.' };
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > MAX_BYTES) return { error: 'That recording is too large.' };
  if (!looksLikeWebm(buf)) return { error: "That isn't a valid video recording." };
  return { buf };
}

function saveRecording(sessionId, buf) {
  fs.writeFileSync(fileFor(sessionId), buf);
}

function readRecording(sessionId) {
  try {
    return fs.readFileSync(fileFor(sessionId));
  } catch {
    return null;
  }
}

function removeRecording(sessionId) {
  try {
    fs.unlinkSync(fileFor(sessionId));
  } catch {
    // already gone
  }
}

module.exports = {
  initRecordings, decodeUpload, saveRecording, readRecording, removeRecording,
  MAX_BYTES, RETENTION_DAYS,
};
