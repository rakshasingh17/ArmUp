import React, { useEffect, useRef, useState } from 'react';
import { EXERCISES } from './engine';
import { drawExerciseHint, fitScale, RIG_BOUNDS } from './avatarDemo';
import { UPPER_BODY_CONNECTIONS } from './usePoseSession';

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
const KEY_MAP = { '1': 'curl', '2': 'raise', '3': 'press', '4': 'neck_tilt' };

export default function ExerciseCanvas({ pose, userId, apiBase, onSessionSaved }) {
  const stageCanvasRef = useRef(null);
  const demoCanvasRef = useRef(null);
  const demoSizeRef = useRef({ w: 200, h: 200 });
  const rafRef = useRef(null);

  const [flash, setFlash] = useState(null);
  const [formFlash, setFormFlash] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

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

  useEffect(() => {
    const onKey = (e) => { if (KEY_MAP[e.key]) setExercise(KEY_MAP[e.key]); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setExercise]);

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
    if (key === exerciseKey) return;
    setExercise(key);
  };

  const handleEndSession = async () => {
    if (stats.reps === 0) { resetStats(); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`${apiBase}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          exercise_key: sessionRef.current.exerciseKey,
          reps: stats.reps,
          score: stats.score,
          accuracy: stats.accuracy,
          max_streak: stats.maxStreak,
          level: stats.level,
        }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      setSaveMsg('Session saved.');
      resetStats();
      onSessionSaved?.();
    } catch (err) {
      console.error('Could not save session:', err);
      setSaveMsg("Couldn't save -- is the backend running?");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

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
        .exc-status { margin-top:10px; font-size:12px; color:#8D8777; }
        .exc-status.err { color:#c94b4b; }
      `}</style>

      <div className="exc-layout">
        <div className="exc-stage">
          <canvas ref={stageCanvasRef} />
          <div className="exc-hud">
            <div className="exc-chip">{EXERCISES[exerciseKey].name}</div>
            <div className="exc-stats">
              <div><div className="val">{stats.score}</div><div className="lbl">Score</div></div>
              <div><div className="val">{stats.reps}</div><div className="lbl">Reps</div></div>
              <div><div className="val">{stats.streak}</div><div className="lbl">Streak</div></div>
              <div><div className="val">{stats.level}</div><div className="lbl">Lvl</div></div>
              <div><div className="val">{stats.accuracy}%</div><div className="lbl">Acc</div></div>
            </div>
            <div className={`exc-warn${partiallyVisible ? ' show' : ''}`}>
              Step back / adjust lighting so your arm is clearly visible
            </div>
            <div className={`exc-flash${flash ? ' show' : ''}${flash?.partial ? ' partial' : ''}`}>
              {flash?.text}
            </div>
            <div className={`exc-form-flash${formFlash ? ' show' : ''}`}>{formFlash?.text}</div>
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
        </div>

        <div className="exc-demo-card">
          <span className="exc-demo-eyebrow">Do a:</span>
          <span className="exc-demo-title">{EXERCISES[exerciseKey].name}</span>
          <div className="exc-demo-stage"><canvas ref={demoCanvasRef} /></div>
          <p className="exc-demo-caption">{DEMO_CAPTIONS[exerciseKey]}</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap justify-center mt-4">
        {EXERCISE_ORDER.map((key, i) => (
          <button
            key={key}
            className={`exc-btn${key === exerciseKey ? ' active' : ''}`}
            onClick={() => handleSwitch(key)}
          >
            {i + 1}. {EXERCISES[key].name}
          </button>
        ))}
        <button className="exc-btn" disabled={saving} onClick={handleEndSession}>
          {saving ? 'Saving…' : 'End session & save'}
        </button>
      </div>

      <p className={`exc-status${error ? ' err' : ''}`}>
        {error ? `${status} (${error})` : status}
        {saveMsg ? ` -- ${saveMsg}` : ''}
        {!trackingOk && cameraOn && !partiallyVisible ? ' -- no one detected in frame yet.' : ''}
      </p>
    </div>
  );
}