import React, { useEffect, useRef, useState } from 'react';
import { EXERCISES } from './engine';
import { drawExerciseHint, fitScale, RIG_BOUNDS } from './avatarDemo';
import { UPPER_BODY_CONNECTIONS } from './usePoseSession';
import { apiFetch } from './api';

/*
 * ExerciseCanvas
 * --------------
 * React port of pose-test.html's tracking stage: mirrored webcam feed
 * with a skeleton overlay + HUD, rep/form flash messages, and the
 * reference-pose avatar card next to it. All camera/model/scoring
 * logic lives in usePoseSession (`pose` prop, one shared instance for
 * both modes) -- this component only draws it.
 *
 * CHANGE: now draws from pose.poseCanvasRef (the hook's internal,
 * already-mirrored detection canvas) instead of drawing+mirroring
 * pose.videoRef itself. That removes a second, redundant mirror
 * transform and guarantees the skeleton overlay and the visible feed
 * are pixel-for-pixel the same source the model actually saw.
 */

const DEMO_MARGIN_PX = 12; // must match avatarDemo.js's fitScale() default

const DEMO_CAPTIONS = {
  curl: "Extend fully, then curl up to your shoulder.",
  raise: "Raise straight out to the side, to shoulder height.",
  press: "Press straight overhead from shoulder height.",
  neck_tilt: "Tilt your head gently toward one shoulder.",
};

const EXERCISE_ORDER = ['curl', 'raise', 'press', 'neck_tilt'];

// A session is one guided set. Tune these numbers to taste:
const SET_REPS = 10;        // a full set; the session saves itself when you reach it
const MIN_SAVE_REPS = 5;    // stopping early with fewer reps than this saves nothing
const COUNTDOWN_SECS = 3;   // "get in position" countdown before the set starts
const KEY_MAP = { '1': 'curl', '2': 'raise', '3': 'press', '4': 'neck_tilt' };

// plan: the patient's prescribed list from GET /users/:id/exercises. When a
// therapist has set a custom plan, only those exercises are offered, in that
// order, each with its own set size. Otherwise all four, 10 reps per set.
export default function ExerciseCanvas({ pose, userId, onSessionSaved, plan = null }) {
  const stageCanvasRef = useRef(null);
  const demoCanvasRef = useRef(null);
  const demoSizeRef = useRef({ w: 200, h: 200 });
  const rafRef = useRef(null);

  const [flash, setFlash] = useState(null);
  const [formFlash, setFormFlash] = useState(null);
  const [saving, setSaving] = useState(false);
  // Set flow: idle -> countdown -> active -> complete
  const [phase, setPhase] = useState('idle');
  const [count, setCount] = useState(COUNTDOWN_SECS);
  const [confirmStop, setConfirmStop] = useState(false);
  const [result, setResult] = useState(null);   // frozen summary of the finished set
  const finishedRef = useRef(false);            // guards against saving one set twice

  const angleReadoutRef = useRef(null); // updated directly in the draw loop below, not via React state -- no need to re-render every frame for a debug number

  const {
    poseCanvasRef, framePointsRef, frameVisRef, liveAngleRef, sessionRef,
    exerciseKey, setExercise,
    cameraOn, starting, startCamera,
    status, error, videoSize,
    stats, resetStats,
    trackingOk, partiallyVisible,
    feedback, formMessage, fps,
  } = pose;

  const customPlan = plan && plan.length && plan.every((p) => p.custom) ? plan : null;
  const planKeys = customPlan ? customPlan.map((p) => p.key).filter((k) => EXERCISES[k]) : [];
  const allowed = planKeys.length ? planKeys : EXERCISE_ORDER;
  const allowedId = allowed.join(',');
  const setReps = (customPlan && customPlan.find((p) => p.key === exerciseKey)?.reps_per_set) || SET_REPS;
  const minSave = Math.min(MIN_SAVE_REPS, setReps - 1);

  // Number keys pick the Nth exercise that is on offer.
  useEffect(() => {
    const onKey = (e) => {
      const key = KEY_MAP[e.key] && allowed[Number(e.key) - 1];
      if (phase === 'idle' && key) setExercise(key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setExercise, phase, allowedId]);

  // If the current exercise isn't in the plan (the tracker starts on curl),
  // move to the plan's first one.
  useEffect(() => {
    if (phase === 'idle' && !allowed.includes(exerciseKey)) setExercise(allowed[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, exerciseKey, allowedId]);

  // 3-2-1 countdown, then the set begins with fresh counters.
  useEffect(() => {
    if (phase !== 'countdown') return;
    const id = setTimeout(() => {
      if (count <= 1) {
        resetStats();
        finishedRef.current = false;
        setPhase('active');
      } else {
        setCount(count - 1);
      }
    }, 1000);
    return () => clearTimeout(id);
  }, [phase, count, resetStats]);


  useEffect(() => {
    if (!feedback) return;
    setFlash({ text: feedback.message, partial: feedback.quality === 'partial' });
    const id = setTimeout(() => setFlash(null), 1000);
    return () => clearTimeout(id);
  }, [feedback]);

  useEffect(() => {
    if (!formMessage) return;
    setFormFlash({ text: formMessage.message });
    const id = setTimeout(() => setFormFlash(null), 1500);
    return () => clearTimeout(id);
  }, [formMessage]);

  useEffect(() => {
    const canvas = stageCanvasRef.current;
    if (!canvas) return;
    canvas.width = videoSize.width;
    canvas.height = videoSize.height;
  }, [videoSize]);

  useEffect(() => {
    const demoCanvas = demoCanvasRef.current;
    if (!demoCanvas) return;
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = demoCanvas.getBoundingClientRect();
      const w = rect.width || 200, h = rect.height || 200;
      demoCanvas.width = Math.round(w * dpr);
      demoCanvas.height = Math.round(h * dpr);
      const ctx = demoCanvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      demoSizeRef.current = { w, h };
    };
    setup();
    window.addEventListener('resize', setup);
    return () => window.removeEventListener('resize', setup);
  }, []);

  useEffect(() => {
    const loop = (t) => {
      const demoCanvas = demoCanvasRef.current;
      if (demoCanvas) {
        const demoCtx = demoCanvas.getContext('2d');
        const { w, h } = demoSizeRef.current;
        demoCtx.clearRect(0, 0, w, h);
        const scale = fitScale(w, h, DEMO_MARGIN_PX);
        const rigCenterX = (RIG_BOUNDS.left + RIG_BOUNDS.right) / 2;
        const originX = w / 2 - rigCenterX * scale;
        const originY = DEMO_MARGIN_PX - RIG_BOUNDS.top * scale;
        drawExerciseHint(demoCtx, exerciseKey, originX, originY, scale, t);
      }

      const canvas = stageCanvasRef.current;
      const poseCanvas = poseCanvasRef.current;
      if (canvas && cameraOn && poseCanvas) {
        const ctx = canvas.getContext('2d');
        // poseCanvas is already mirrored -- draw it straight across,
        // no transform needed.
        ctx.drawImage(poseCanvas, 0, 0, canvas.width, canvas.height);

        const framePoints = framePointsRef.current;
        if (framePoints.LEFT_SHOULDER) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#3FE0D0';
          for (const [a, b] of UPPER_BODY_CONNECTIONS) {
            if (!framePoints[a] || !framePoints[b]) continue;
            ctx.beginPath();
            ctx.moveTo(framePoints[a].x, framePoints[a].y);
            ctx.lineTo(framePoints[b].x, framePoints[b].y);
            ctx.stroke();
          }
          ctx.fillStyle = '#FF6B8B';
          const drawn = new Set();
          for (const [a, b] of UPPER_BODY_CONNECTIONS) {
            for (const name of [a, b]) {
              if (!drawn.has(name) && framePoints[name]) {
                drawn.add(name);
                ctx.beginPath();
                ctx.arc(framePoints[name].x, framePoints[name].y, 6, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
          if (exerciseKey === 'neck_tilt' && framePoints.NOSE && framePoints.NECK_BASE) {
            ctx.strokeStyle = '#D5E05E';
            ctx.beginPath();
            ctx.moveTo(framePoints.NECK_BASE.x, framePoints.NECK_BASE.y);
            ctx.lineTo(framePoints.NOSE.x, framePoints.NOSE.y);
            ctx.stroke();
          }
        }
      }

      // Debug angle readout -- written directly to the DOM (not React
      // state) so it can update every frame without triggering a
      // re-render. For tuning EXERCISES.rest/peak in engine.js against
      // your actual camera setup -- see engine.js's press comment.
      if (angleReadoutRef.current) {
        const ex = EXERCISES[exerciseKey];
        const live = liveAngleRef.current;
        angleReadoutRef.current.textContent = live == null
          ? `angle: -- (target ${ex.rest}\u00B1${ex.tolerance} / ${ex.peak}\u00B1${ex.tolerance})`
          : `angle: ${Math.round(live)}\u00B0 (target ${ex.rest}\u00B1${ex.tolerance} / ${ex.peak}\u00B1${ex.tolerance})`;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, exerciseKey]);

  const handleSwitch = (key) => {
    if (phase !== 'idle' || key === exerciseKey) return;
    setExercise(key);
  };

  const startSet = () => {
    setResult(null);
    setConfirmStop(false);
    setCount(COUNTDOWN_SECS);
    setPhase('countdown');
  };

  const cancelCountdown = () => setPhase('idle');

  const postSession = async (final, exKey) => {
    setSaving(true);
    try {
      const res = await apiFetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          exercise_key: exKey,
          reps: final.reps,
          score: final.score,
          accuracy: final.accuracy,
          max_streak: final.maxStreak,
          level: final.level,
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

  // Ends the set. A full set always saves; an early stop saves only if it
  // reached minSave, so a couple of stray reps never become a session.
  const finishSet = async (final, early) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const exKey = sessionRef.current.exerciseKey;
    const willSave = !early || final.reps >= minSave;
    setConfirmStop(false);
    setPhase('complete');
    setResult({ ...final, exerciseKey: exKey, early, discarded: !willSave, saved: null });
    if (willSave) {
      const saved = await postSession(final, exKey);
      setResult((r) => (r ? { ...r, saved } : r));
    }
  };

  // Reaching the target ends the set and saves it automatically.
  useEffect(() => {
    if (phase === 'active' && stats.reps >= setReps) finishSet(stats, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stats.reps]);

  const retrySave = async () => {
    if (!result) return;
    const saved = await postSession(result, result.exerciseKey);
    setResult((r) => (r ? { ...r, saved } : r));
  };

  const nextExercise = () => {
    const i = allowed.indexOf(result?.exerciseKey ?? exerciseKey);
    setExercise(allowed[(i + 1) % allowed.length]);
    setResult(null);
    setPhase('idle');
  };

  const backToStart = () => { setResult(null); setPhase('idle'); };

  // While a finished set's summary is up, the HUD shows its frozen numbers.
  const shown = phase === 'complete' && result ? result : stats;

  return (
    <div className="exc-root">
      <style>{`
        .exc-root { --exc-accent:#FF6B8B; --exc-limb:#3FE0D0; --exc-good:#5CE0A0; --exc-warn:#FFC15E; }
        .exc-layout { display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; }
        .exc-stage { position:relative; flex:1 1 480px; min-width:280px; aspect-ratio:4/3; background:#0d0714; border-radius:16px; overflow:hidden; }
        .exc-stage canvas { width:100%; height:100%; display:block; }
        .exc-hud { position:absolute; inset:0; pointer-events:none; font-size:13px; color:#F3F6FA; }
        .exc-chip { position:absolute; top:12px; left:12px; background:#241832cc; border:1px solid var(--exc-accent); border-radius:12px; padding:8px 14px; font-weight:600; }
        .exc-stats { position:absolute; top:12px; right:12px; display:flex; gap:14px; background:#241832cc; border:1px solid #ffffff30; border-radius:12px; padding:8px 14px; }
        .exc-stats div { text-align:center; }
        .exc-stats .val { font-size:16px; font-weight:700; color:var(--exc-limb); }
        .exc-stats .lbl { font-size:10px; text-transform:uppercase; color:#9AA8C4; }
        .exc-flash, .exc-form-flash, .exc-warn { position:absolute; left:50%; transform:translateX(-50%); border-radius:14px; padding:10px 18px; font-weight:600; opacity:0; transition:opacity .15s; }
        .exc-flash { top:60px; background:#14281ed0; color:var(--exc-good); }
        .exc-flash.partial { background:#2d1e14d0; color:var(--exc-warn); }
        .exc-form-flash { top:112px; background:#2d1e14d0; color:var(--exc-warn); padding:8px 16px; }
        .exc-warn { top:60px; background:#2d1e14d0; color:var(--exc-warn); font-size:12px; padding:6px 14px; }
        .exc-flash.show, .exc-form-flash.show, .exc-warn.show { opacity:1; }
        .exc-bar { position:absolute; bottom:12px; left:12px; right:12px; background:#241832cc; border-radius:12px; padding:8px 14px; font-size:11px; color:#9AA8C4; display:flex; justify-content:space-between; }
        .exc-startlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:#0d0714cc; }
        .exc-demo-card { width:190px; flex-shrink:0; background:#241832cc; border:1px solid #ffffff30; border-radius:16px; padding:14px; display:flex; flex-direction:column; align-items:center; gap:8px; }
        .exc-demo-eyebrow { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#9AA8C4; align-self:flex-start; }
        .exc-demo-title { font-size:15px; font-weight:700; align-self:flex-start; margin-top:-4px; color:#F3F6FA; }
        .exc-demo-stage { width:100%; aspect-ratio:1/1; background:radial-gradient(circle at 50% 30%, #2c1d47 0%, #180c2c 75%); border-radius:12px; overflow:hidden; }
        .exc-demo-stage canvas { width:100%; height:100%; display:block; }
        .exc-demo-caption { font-size:11.5px; color:#9AA8C4; text-align:center; line-height:1.4; }
        .exc-btn { background:#241832; color:#F3F6FA; border:1px solid #ffffff30; border-radius:10px; padding:8px 16px; font-size:13px; cursor:pointer; }
        .exc-btn.active { background:var(--exc-accent); border-color:var(--exc-accent); color:#1B1035; font-weight:700; }
        .exc-btn.start { background:var(--exc-good); color:#10281c; font-weight:700; border:none; }
        .exc-btn:disabled { opacity:.5; cursor:default; }
        .exc-progress { position:absolute; left:12px; right:12px; bottom:54px; }
        .exc-progress-label { font-size:12px; font-weight:600; margin-bottom:4px; text-shadow:0 1px 3px #000a; }
        .exc-progress-track { height:10px; background:#ffffff30; border-radius:6px; overflow:hidden; }
        .exc-progress-fill { height:100%; background:var(--exc-good); border-radius:6px; transition:width .25s; }
        .exc-ready { position:absolute; left:50%; bottom:58px; transform:translateX(-50%); width:min(92%, 420px); background:#241832ee; border:1px solid #ffffff30; border-radius:16px; padding:14px 18px; text-align:center; color:#F3F6FA; display:flex; flex-direction:column; align-items:center; gap:6px; }
        .exc-ready-title { font-size:16px; font-weight:700; }
        .exc-ready-sub { font-size:12px; color:#9AA8C4; margin-bottom:4px; }
        .exc-countdown { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#fff; pointer-events:none; text-shadow:0 2px 12px #000a; }
        .exc-countdown span { font-size:110px; font-weight:800; line-height:1; }
        .exc-countdown p { font-size:16px; margin-top:6px; }
        .exc-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:#0d0714d9; padding:16px; }
        .exc-card { width:min(100%, 440px); background:#241832; border:1px solid #ffffff30; border-radius:18px; padding:22px; text-align:center; color:#F3F6FA; }
        .exc-card h3 { font-size:22px; font-weight:800; margin-bottom:6px; }
        .exc-card p { font-size:13px; color:#C9D2E6; line-height:1.45; }
        .exc-card .exc-card-ex { color:#9AA8C4; margin-bottom:14px; }
        .exc-card-stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin-bottom:14px; }
        .exc-card-stats div { background:#ffffff10; border-radius:12px; padding:10px 4px; display:flex; flex-direction:column; gap:2px; }
        .exc-card-stats b { font-size:20px; color:var(--exc-limb); }
        .exc-card-stats span { font-size:10px; text-transform:uppercase; color:#9AA8C4; }
        .exc-card .exc-card-save { margin-bottom:14px; }
        .exc-card-actions { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:12px; }
        .exc-status { margin-top:10px; font-size:12px; color:#8D8777; }
        .exc-status.err { color:#c94b4b; }
      `}</style>

      <div className="exc-layout">
        <div className="exc-stage">
          <canvas ref={stageCanvasRef} />
          <div className="exc-hud">
            <div className="exc-chip">{EXERCISES[exerciseKey].name}</div>
            <div className="exc-stats">
              <div><div className="val">{shown.score}</div><div className="lbl">Score</div></div>
              <div><div className="val">{shown.reps}</div><div className="lbl">Reps</div></div>
              <div><div className="val">{shown.streak}</div><div className="lbl">Streak</div></div>
              <div><div className="val">{shown.level}</div><div className="lbl">Lvl</div></div>
              <div><div className="val">{shown.accuracy}%</div><div className="lbl">Acc</div></div>
            </div>
            <div className={`exc-warn${partiallyVisible ? ' show' : ''}`}>
              Step back / adjust lighting so your arm is clearly visible
            </div>
            <div className={`exc-flash${flash ? ' show' : ''}${flash?.partial ? ' partial' : ''}`}>
              {flash?.text}
            </div>
            <div className={`exc-form-flash${formFlash ? ' show' : ''}`}>{formFlash?.text}</div>
            {(phase === 'active' || phase === 'countdown') && (
              <div className="exc-progress">
                <div className="exc-progress-label">
                  {phase === 'countdown' ? 'Get ready' : `Rep ${Math.min(stats.reps, setReps)} of ${setReps}`}
                </div>
                <div className="exc-progress-track">
                  <div className="exc-progress-fill" style={{ width: `${phase === 'active' ? Math.min(100, (stats.reps / setReps) * 100) : 0}%` }} />
                </div>
              </div>
            )}
            <div className="exc-bar">
              <span>1 Curl &nbsp; 2 Lateral Raise &nbsp; 3 Shoulder Press &nbsp; 4 Neck Tilt</span>
              <span>
                <span ref={angleReadoutRef}>angle: --</span>
                &nbsp;&nbsp;FPS: {cameraOn ? fps : '--'}
              </span>
            </div>
          </div>
          {!cameraOn && (
            <div className="exc-startlay">
              <button className="exc-btn start" disabled={starting} onClick={startCamera}>
                {starting ? 'Starting…' : 'Start camera'}
              </button>
            </div>
          )}
          {cameraOn && phase === 'idle' && (
            <div className="exc-ready">
              <div className="exc-ready-title">{EXERCISES[exerciseKey].name}</div>
              <div className="exc-ready-sub">One set = {setReps} reps. Stand where your arm is fully in view.</div>
              <button className="exc-btn start" onClick={startSet}>Start set</button>
            </div>
          )}
          {phase === 'countdown' && (
            <div className="exc-countdown"><span>{count}</span><p>Get into position</p></div>
          )}
          {confirmStop && (
            <div className="exc-overlay">
              <div className="exc-card">
                <h3>Stop this set?</h3>
                <p>
                  {stats.reps >= minSave
                    ? `You've done ${stats.reps} of ${setReps} reps. They'll be saved as a shorter session.`
                    : `You've done ${stats.reps} of ${setReps} reps. It takes at least ${minSave} to save a session, so this one won't be saved.`}
                </p>
                <div className="exc-card-actions">
                  <button className="exc-btn start" onClick={() => setConfirmStop(false)}>Keep going</button>
                  <button className="exc-btn" onClick={() => finishSet(stats, true)}>Stop set</button>
                </div>
              </div>
            </div>
          )}
          {phase === 'complete' && result && (
            <div className="exc-overlay">
              <div className="exc-card">
                <h3>{result.discarded ? 'Set not saved' : result.early ? 'Set stopped early' : 'Set complete!'}</h3>
                <p className="exc-card-ex">{EXERCISES[result.exerciseKey].name} · {result.reps} of {setReps} reps</p>
                <div className="exc-card-stats">
                  <div><b>{result.score}</b><span>Score</span></div>
                  <div><b>{result.accuracy}%</b><span>Accuracy</span></div>
                  <div><b>{result.maxStreak}</b><span>Best streak</span></div>
                  <div><b>{result.level}</b><span>Level</span></div>
                </div>
                <p className="exc-card-save">
                  {result.discarded
                    ? `Fewer than ${minSave} reps, so nothing was recorded.`
                    : saving || result.saved === null
                      ? 'Saving your session…'
                      : result.saved
                        ? 'Saved to your session log.'
                        : "Couldn't save this session."}
                </p>
                <div className="exc-card-actions">
                  {!result.discarded && result.saved === false && (
                    <button className="exc-btn" disabled={saving} onClick={retrySave}>Try saving again</button>
                  )}
                  <button className="exc-btn start" onClick={nextExercise}>Next exercise</button>
                  <button className="exc-btn" onClick={backToStart}>Repeat this one</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="exc-demo-card">
          <span className="exc-demo-eyebrow">Do a:</span>
          <span className="exc-demo-title">{EXERCISES[exerciseKey].name}</span>
          <div className="exc-demo-stage"><canvas ref={demoCanvasRef} /></div>
          <p className="exc-demo-caption">{DEMO_CAPTIONS[exerciseKey]}</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap justify-center mt-4">
        {allowed.map((key, i) => (
          <button
            key={key}
            className={`exc-btn${key === exerciseKey ? ' active' : ''}`}
            disabled={phase !== 'idle'}
            onClick={() => handleSwitch(key)}
          >
            {i + 1}. {EXERCISES[key].name}
          </button>
        ))}
        {phase === 'countdown' && (
          <button className="exc-btn" onClick={cancelCountdown}>Cancel</button>
        )}
        {phase === 'active' && (
          <button className="exc-btn" onClick={() => setConfirmStop(true)}>Stop set</button>
        )}
      </div>

      <p className={`exc-status${error ? ' err' : ''}`}>
        {error ? `${status} (${error})` : status}
        {!trackingOk && cameraOn && !partiallyVisible ? ' -- no one detected in frame yet.' : ''}
      </p>
    </div>
  );
}