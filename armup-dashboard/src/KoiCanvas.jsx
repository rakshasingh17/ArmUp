import { useEffect, useRef, useState } from 'react';
import { MIN_VISIBILITY } from './engine';
import { apiFetch } from './api';
import { createKoiGame, KOI_W, KOI_H } from './koiGame';

/*
 * KoiCanvas
 * ---------
 * "Koi chase" -- the calm, no-fail game mode for adults and older patients.
 * The koi follows the patient's wrist (from the shared usePoseSession camera);
 * reaching it to a glowing lotus bud makes it bloom. There is no timer, no
 * game over and no combo pressure in Calm mode.
 *
 * Rendering lives in koiGame.js; this file is the camera input, the Start /
 * Finish flow and saving the session.
 */

const MIN_SAVE_BLOOMS = 3; // fewer than this and nothing is recorded
const KOI_KEY = 'koi';     // must exist in the exercises table (see electron/db.cjs)

// Which part of the camera picture covers the whole pond. Using the middle of
// the frame means nobody has to reach to the very edge of the camera view.
const REGION = { x0: 0.12, x1: 0.88, y0: 0.08, y1: 0.8 };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// The camera picture is mirrored, so the model's LEFT_* is the patient's
// physical right side (see usePoseSession.js).
const SIDE_WRISTS = { auto: ['LEFT_WRIST', 'RIGHT_WRIST'], right: ['LEFT_WRIST'], left: ['RIGHT_WRIST'] };

const btnPrimary = 'font-display px-5 py-2.5 rounded-full bg-[#5CE0A0] text-[#10281c] font-semibold disabled:opacity-60';
const btnGhost = 'font-display px-4 py-2 rounded-full bg-white/15 border border-white/30 disabled:opacity-60';

function Seg({ label, value, options, onChange }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-[#8D8777] whitespace-nowrap">{label}</span>
      {options.map(([val, text]) => (
        <button
          key={val}
          onClick={() => onChange(val)}
          className={`font-display text-xs px-3 py-1.5 rounded-full transition-colors ${
            value === val ? 'bg-[#17140F] text-[#E9E4D6]' : 'bg-white border border-[#E7E2D4] text-[#8D8777]'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export default function KoiCanvas({ pose, userId, onSessionSaved }) {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const poseRef = useRef(pose);
  const sideRef = useRef('auto');
  const wristRef = useRef(null);       // which wrist we are following right now
  const startedAtRef = useRef(0);
  const savedOnceRef = useRef(false);

  const [mode, setMode] = useState('calm');
  const [side, setSide] = useState('auto');
  const [phase, setPhase] = useState('idle'); // idle | playing | complete
  const [tracking, setTracking] = useState(false);
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { poseRef.current = pose; });
  useEffect(() => { sideRef.current = side; wristRef.current = null; }, [side]);

  // Picks the wrist to follow and maps it onto the pond. Called every frame.
  const getHand = () => {
    const p = poseRef.current;
    const cv = p.poseCanvasRef.current;
    const pts = p.framePointsRef.current;
    const vis = p.frameVisRef.current;
    if (!cv || !pts) return null;
    const names = SIDE_WRISTS[sideRef.current];
    const seen = (n) => pts[n] && (vis[n] ?? 0) > MIN_VISIBILITY;
    let pick = wristRef.current && names.includes(wristRef.current) && seen(wristRef.current) ? wristRef.current : null;
    if (!pick) {
      // Prefer the raised hand when both are visible.
      const cands = names.filter(seen).sort((a, b) => pts[a].y - pts[b].y);
      pick = cands[0] || null;
    }
    wristRef.current = pick;
    if (!pick) return null;
    const px = pts[pick].x / cv.width, py = pts[pick].y / cv.height;
    return {
      x: clamp01((px - REGION.x0) / (REGION.x1 - REGION.x0)),
      y: clamp01((py - REGION.y0) / (REGION.y1 - REGION.y0)),
      px, py,
    };
  };

  useEffect(() => {
    const game = createKoiGame(canvasRef.current, {
      getHand,
      getPreview: () => poseRef.current.poseCanvasRef.current,
    });
    gameRef.current = game;
    const poll = setInterval(() => setTracking(game.isTracking()), 300);
    return () => { clearInterval(poll); game.destroy(); gameRef.current = null; };
    // getHand only reads refs, so it is safe to create the game once.
  }, []);

  useEffect(() => { gameRef.current?.setMode(mode); }, [mode]);

  const postSession = async (final) => {
    setSaving(true);
    try {
      const res = await apiFetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          exercise_key: KOI_KEY,
          reps: final.blooms,          // one bloom = one reach
          score: final.points * 10,    // pink 1, purple 2, gold 3 points per flower
          accuracy: 100,               // no misses in this game
          max_streak: final.maxCombo,
          level: 1,
          form_faults: {},
        }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      onSessionSaved?.();
      return true;
    } catch (err) {
      console.error('Could not save session:', err);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const start = () => {
    const game = gameRef.current;
    if (!game) return;
    game.unlockAudio();
    game.reset();
    startedAtRef.current = Date.now();
    savedOnceRef.current = false;
    setResult(null);
    setPhase('playing');
  };

  const finish = async () => {
    if (savedOnceRef.current) return;
    savedOnceRef.current = true;
    const { blooms, points, maxCombo } = gameRef.current.stats();
    const seconds = Math.round((Date.now() - startedAtRef.current) / 1000);
    const discarded = blooms < MIN_SAVE_BLOOMS;
    const final = { blooms, points, maxCombo, seconds, discarded, saved: null };
    setResult(final);
    setPhase('complete');
    if (!discarded) {
      const saved = await postSession(final);
      setResult((r) => (r ? { ...r, saved } : r));
    }
  };

  const retrySave = async () => {
    if (!result) return;
    const saved = await postSession(result);
    setResult((r) => (r ? { ...r, saved } : r));
  };

  const { cameraOn, starting, startCamera, error: cameraError } = pose;
  const mins = result ? Math.floor(result.seconds / 60) : 0;

  return (
    <div className="w-full">
      <div
        className="w-full relative rounded-2xl overflow-hidden border border-[#E7E2D4] bg-[#051a28]"
        style={{ aspectRatio: `${KOI_W} / ${KOI_H}` }}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />

        {!cameraOn && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/50 px-8 text-center">
            {cameraError && <p className="max-w-md text-sm text-[#ffb4b4]">{cameraError}</p>}
            <p className="font-display text-xl text-white">Koi chase</p>
            <p className="max-w-sm text-sm text-white/80">A calm game: guide the koi with your hand and make the lotus flowers bloom. Reaching for the flowers is gentle arm and shoulder movement practice.</p>
            <button onClick={startCamera} disabled={starting} className={btnPrimary}>
              {starting ? 'Starting…' : 'Start camera'}
            </button>
          </div>
        )}

        {cameraOn && phase === 'idle' && (
          <div className="absolute inset-x-0 bottom-6 flex justify-center px-4">
            <div className="w-full max-w-md bg-[#0a3f52]/95 border border-white/20 rounded-2xl px-5 py-4 text-center text-white flex flex-col items-center gap-1.5">
              <p className="font-display text-lg font-semibold">Koi chase</p>
              <p className="text-xs text-white/80">
                Sit comfortably with your arms and shoulders in view. Move your hand to swim the koi to the glowing buds. Pink flowers are worth 1 point, purple 2 and gold 3. There is no timer; finish whenever you like.
              </p>
              <p className="text-xs text-white/60">
                Active mode adds a rival fish that may snatch a flower. It never takes your points.
              </p>
              <p className="text-xs text-white/70 border-t border-white/15 pt-2 mt-1">
                <span className="font-semibold text-white/90">Why this game?</span> Reaching toward each flower
                gently moves your arm and shoulder through a comfortable range, like the movements in your exercises,
                and it&apos;s easier to keep going when it feels like play. Reach as far as is comfortable and go at
                your own pace. Stop if anything hurts.
              </p>
              <button onClick={start} className={`${btnPrimary} mt-1`}>Start</button>
            </div>
          </div>
        )}

        {cameraOn && phase === 'playing' && !tracking && (
          <div className="absolute top-3 inset-x-0 flex justify-center px-4 pointer-events-none">
            <p className="text-sm text-white bg-black/55 rounded-full px-4 py-2">
              We can’t see your hand. Sit back so your upper body is in view.
            </p>
          </div>
        )}

        {phase === 'complete' && result && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-md bg-[#0a3f52] border border-white/20 rounded-2xl p-5 text-center text-white">
              <h3 className="font-display text-2xl font-semibold">
                {result.discarded ? 'Session ended' : 'Beautiful pond!'}
              </h3>
              <p className="text-sm text-white/70 mb-3">
                {result.blooms} lotus {result.blooms === 1 ? 'flower' : 'flowers'} bloomed for {result.points} {result.points === 1 ? 'point' : 'points'}
                {mins >= 1 ? ` in about ${mins} min` : ''}.
              </p>
              <p className="text-sm text-white/80">
                {result.discarded
                  ? `Fewer than ${MIN_SAVE_BLOOMS} flowers, so nothing was recorded.`
                  : saving || result.saved === null
                    ? 'Saving your session…'
                    : result.saved ? 'Saved to your session log.' : 'We couldn’t save this session.'}
              </p>
              <div className="flex gap-2 justify-center flex-wrap mt-4">
                {!result.discarded && result.saved === false && (
                  <button onClick={retrySave} disabled={saving} className={btnGhost}>Try saving again</button>
                )}
                <button onClick={() => { setResult(null); setPhase('idle'); }} className={btnPrimary}>Play again</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-x-5 gap-y-2 mt-3 flex-wrap">
        <Seg label="Mode" value={mode} onChange={setMode} options={[['calm', 'Calm'], ['active', 'Active']]} />
        <Seg label="Hand" value={side} onChange={setSide} options={[['auto', 'Either'], ['right', 'Right'], ['left', 'Left']]} />
        {phase === 'playing' && (
          <button onClick={finish} className="font-display text-xs px-3 py-1.5 rounded-full bg-white border border-[#E7E2D4] text-[#8D8777] ml-auto">
            Finish
          </button>
        )}
      </div>
    </div>
  );
}
