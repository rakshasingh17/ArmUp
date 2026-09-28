import React, { useEffect, useRef, useState } from 'react';
import { EXERCISES } from './engine';

/*
 * GameCanvas
 * ----------
 * The render loop for the "spell battle" game mode.
 *
 * CHANGE: the player box now draws pose.poseCanvasRef (the hook's
 * internal, already-mirrored detection canvas) instead of mirroring
 * pose.videoRef itself -- same reasoning as ExerciseCanvas: one fewer
 * mirror transform, and it's guaranteed to be the same frame the
 * model actually detected against.
 */

const CANVAS_W = 960;
const CANVAS_H = 540;

const ASSETS = {
  sky: '/game/cave-sky.png',
  main: '/game/cave-bg.png',
  fg: '/game/cave-fg.png',
  idle: '/game/wizard/idle.png',
  takeHit: '/game/wizard/take-hit.png',
  death: '/game/wizard/death.png',
};

// Fight tuning. Each correct rep = 1 damage. Every villain you beat is
// a bit tougher than the last, capped so it never becomes a slog.
const BASE_VILLAIN_HP = 10;
const HP_PER_VILLAIN = 2;
const MAX_VILLAIN_HP = 20;
const REPS_PER_LEVEL = 5; // matches SessionState._maybeLevelUp in engine.js

const EXERCISE_ORDER = ['curl', 'raise', 'press', 'neck_tilt'];

function useImage(src) {
  const [img, setImg] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setImg(image); };
    image.onerror = () => { if (!cancelled) setFailed(true); };
    image.src = src;
    return () => { cancelled = true; };
  }, [src]);
  return [img, failed];
}

function useSpriteSheet(src, frameW, frameH, frameCount) {
  const [img] = useImage(src);
  return { img, frameW, frameH, frameCount };
}

function drawSpriteFrame(ctx, sheet, x, y, scale, playhead, fps, loop = true, flip = false) {
  if (!sheet.img) return { drawn: false, finished: false };
  const rawIndex = Math.floor((playhead / 1000) * fps);
  const finished = !loop && rawIndex >= sheet.frameCount;
  const frameIndex = loop
    ? rawIndex % sheet.frameCount
    : Math.min(rawIndex, sheet.frameCount - 1);
  const fx = frameIndex * sheet.frameW;
  const drawW = sheet.frameW * scale;
  const drawH = sheet.frameH * scale;

  ctx.save();
  if (flip) {
    ctx.translate(x + drawW, y);
    ctx.scale(-1, 1);
    ctx.drawImage(sheet.img, fx, 0, sheet.frameW, sheet.frameH, 0, 0, drawW, drawH);
  } else {
    ctx.drawImage(sheet.img, fx, 0, sheet.frameW, sheet.frameH, x, y, drawW, drawH);
  }
  ctx.restore();
  return { drawn: true, finished };
}

function drawFallbackBackground(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  g.addColorStop(0, '#241832');
  g.addColorStop(1, '#0d0714');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '12px monospace';
  ctx.fillText('(cave assets not found -- check /public/game/)', 14, CANVAS_H - 14);
}

function drawScrollingLayer(ctx, img, scrollX, scale) {
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const y = CANVAS_H - drawH;
  let x = -((scrollX % drawW) + drawW) % drawW;
  while (x < CANVAS_W) {
    ctx.drawImage(img, x, y, drawW, drawH);
    x += drawW;
  }
}

function drawBackground(ctx, sky, main, fg, anyFailed, t) {
  if (!sky && !main) {
    drawFallbackBackground(ctx);
    return;
  }
  if (sky) ctx.drawImage(sky, 0, 0, CANVAS_W, CANVAS_H);

  if (main) {
    const scale = CANVAS_W / main.width;
    ctx.drawImage(main, 0, CANVAS_H - main.height * scale, CANVAS_W, main.height * scale);
  }

  if (fg) {
    const scale = (CANVAS_W / fg.width) * 1.05;
    drawScrollingLayer(ctx, fg, t / 40, scale);
  }

  if (anyFailed) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '12px monospace';
    ctx.fillText('(one or more cave layers failed to load -- check /public/game/)', 14, CANVAS_H - 14);
  }
}

// Player box -- draws the hook's already-mirrored detection canvas,
// cropped (object-fit: cover style) to fill the box without distorting
// the aspect ratio. No mirroring done here -- poseCanvas is already
// mirrored by the hook.
function drawPlayerBox(ctx, poseCanvas, x, y, w, h, cameraOn) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  if (cameraOn && poseCanvas && poseCanvas.width) {
    const vw = poseCanvas.width, vh = poseCanvas.height;
    const boxRatio = w / h, vidRatio = vw / vh;
    let sw = vw, sh = vh, sx = 0, sy = 0;
    if (vidRatio > boxRatio) { sw = vh * boxRatio; sx = (vw - sw) / 2; }
    else { sh = vw / boxRatio; sy = (vh - sh) / 2; }
    ctx.drawImage(poseCanvas, sx, sy, sw, sh, x, y, w, h);
  } else {
    ctx.fillStyle = 'rgba(20,14,32,0.6)';
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(x, y, w, h);
  if (!cameraOn) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '13px sans-serif';
    ctx.fillText('Start the camera to cast spells', x + 10, y - 10);
  }
  ctx.restore();
}

function drawOrb(ctx, x, y, progress, t) {
  const radius = 18 + progress * 38;
  const pulse = 1 + Math.sin(t / 150) * 0.06 * (0.3 + progress);

  ctx.save();
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius * pulse * 1.8);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  grad.addColorStop(0.35, `rgba(140, 210, 255, ${0.7 + progress * 0.3})`);
  grad.addColorStop(1, 'rgba(80, 120, 255, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius * pulse * 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#eaf6ff';
  ctx.beginPath();
  ctx.arc(x, y, radius * pulse * 0.5, 0, Math.PI * 2);
  ctx.fill();

  const particleCount = Math.round(4 + progress * 14);
  for (let i = 0; i < particleCount; i++) {
    const a = (i / particleCount) * Math.PI * 2 + t / 800;
    const r = radius * pulse * 1.3 + Math.sin(t / 200 + i) * 4;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    ctx.fillStyle = `rgba(190, 230, 255, ${0.5 + progress * 0.5})`;
    ctx.beginPath();
    ctx.arc(px, py, 1.5 + progress * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawImpactBurst(ctx, x, y, age) {
  if (age >= 1) return;
  const alpha = 1 - age;
  const r = 20 + age * 70;
  ctx.save();
  ctx.strokeStyle = `rgba(255, 240, 200, ${alpha})`;
  ctx.lineWidth = 4 * (1 - age) + 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const dist = r * 0.9;
    ctx.fillStyle = `rgba(255, 220, 160, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * dist, y + Math.sin(a) * dist, 3 * (1 - age), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Boss bar: `shown` is the smoothly-draining value, `hp` the real one --
// the pale "ghost" segment between them is the classic damage-trail.
function drawBossBar(ctx, name, shown, hp, maxHp, t, flash) {
  const w = 360, h = 20, x = (CANVAS_W - w) / 2, y = 34;
  ctx.save();
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${name}  ${hp}/${maxHp}`, CANVAS_W / 2, y - 8);

  ctx.fillStyle = 'rgba(15,8,25,0.75)';
  roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 10); ctx.fill();

  ctx.save();
  roundRect(ctx, x, y, w, h, 8); ctx.clip();
  ctx.fillStyle = '#2b1a3a';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,220,200,0.55)';               // damage trail
  ctx.fillRect(x, y, w * Math.max(0, shown / maxHp), h);
  const pct = hp / maxHp;
  ctx.fillStyle = pct > 0.5 ? '#e0405a' : pct > 0.25 ? '#e07a40' : '#ffcf4a';
  ctx.fillRect(x, y, w * pct, h);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';               // gloss
  ctx.fillRect(x, y, w * pct, h / 2);
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flash * 0.7})`;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
  ctx.restore();
}

function drawXpBar(ctx, level, reps, score) {
  const w = 190, h = 12, x = 20, y = 40;
  const inLevel = reps % REPS_PER_LEVEL;
  ctx.save();
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText(`LV ${level}`, x, y - 8);
  ctx.font = '11px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText(`${score} XP`, x + 52, y - 8);
  ctx.fillStyle = 'rgba(15,8,25,0.75)';
  roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 7); ctx.fill();
  ctx.save();
  roundRect(ctx, x, y, w, h, 5); ctx.clip();
  ctx.fillStyle = '#2b1a3a';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#5CE0A0';
  ctx.fillRect(x, y, w * (inLevel / REPS_PER_LEVEL), h);
  ctx.restore();
  ctx.restore();
}

export default function GameCanvas({ pose, userId, apiBase, onSessionSaved }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  const {
    poseCanvasRef, progressRef, liveAngleRef, sessionRef,
    exerciseKey, setExercise,
    cameraOn, starting, startCamera,
    stats, resetStats, getSnapshot,
    feedback, error: cameraError,
  } = pose;

  const [sky, skyFailed] = useImage(ASSETS.sky);
  const [main, mainFailed] = useImage(ASSETS.main);
  const [fg, fgFailed] = useImage(ASSETS.fg);
  const anyBgFailed = skyFailed || mainFailed || fgFailed;

  const idleSheet = useSpriteSheet(ASSETS.idle, 150, 150, 8);
  const takeHitSheet = useSpriteSheet(ASSETS.takeHit, 150, 150, 4);
  const deathSheet = useSpriteSheet(ASSETS.death, 150, 150, 5);

  // Fight state lives in refs (read every frame by the draw loop).
  // `defeated` / `villainsDefeated` are React state only because the
  // victory overlay is DOM and needs to re-render when they change.
  const hpRef = useRef(BASE_VILLAIN_HP);
  const maxHpRef = useRef(BASE_VILLAIN_HP);
  const shownHpRef = useRef(BASE_VILLAIN_HP);   // smoothed, for the drain animation
  const hitFlashRef = useRef(0);
  const [defeated, setDefeated] = useState(false);
  const [villainsDefeated, setVillainsDefeated] = useState(0);
  const wizardStateRef = useRef('idle'); // 'idle' | 'takeHit' | 'dying' | 'dead'
  const wizardPlayheadRef = useRef(0);
  const lastFrameTimeRef = useRef(null);
  const impactRef = useRef(null);

  const orbStartX = 260;
  const orbEndX = CANVAS_W - 260;
  const orbY = CANVAS_H - 150;
  const wizardX = CANVAS_W - 340;
  const wizardY = CANVAS_H - 300;
  const wizardScale = 2;
  const playerBox = { x: 60, y: CANVAS_H - 260, w: 220, h: 260 };

  // A correct rep = one hit on the villain. The last hit plays the
  // death animation instead of the flinch.
  const landHit = () => {
    if (wizardStateRef.current === 'dying' || wizardStateRef.current === 'dead') return;
    hpRef.current = Math.max(0, hpRef.current - 1);
    wizardPlayheadRef.current = 0;
    hitFlashRef.current = 1;
    impactRef.current = { x: orbEndX, y: orbY, startedAt: performance.now() };
    wizardStateRef.current = hpRef.current === 0 ? 'dying' : 'takeHit';
  };

  // The hook keeps its last feedback event around, so without this a
  // stale rep_complete from Exercise mode would land a phantom hit the
  // moment Game mode mounts. Only react to events newer than mount.
  const lastFeedbackAtRef = useRef(feedback?.at ?? null);
  useEffect(() => {
    if (!feedback || feedback.at === lastFeedbackAtRef.current) return;
    lastFeedbackAtRef.current = feedback.at;
    if (feedback.event === 'rep_complete') landHit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedback]);

  const nextVillain = () => {
    const n = villainsDefeated;   // already incremented when the last one fell
    const hp = Math.min(BASE_VILLAIN_HP + HP_PER_VILLAIN * n, MAX_VILLAIN_HP);
    maxHpRef.current = hp;
    hpRef.current = hp;
    shownHpRef.current = hp;
    wizardStateRef.current = 'idle';
    wizardPlayheadRef.current = 0;
    setDefeated(false);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const loop = (t) => {
      if (lastFrameTimeRef.current == null) lastFrameTimeRef.current = t;
      const dt = t - lastFrameTimeRef.current;
      lastFrameTimeRef.current = t;
      wizardPlayheadRef.current += dt;

      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      drawBackground(ctx, sky, main, fg, anyBgFailed, t);

      drawPlayerBox(ctx, poseCanvasRef.current, playerBox.x, playerBox.y, playerBox.w, playerBox.h, cameraOn);

      if (wizardStateRef.current === 'dying' || wizardStateRef.current === 'dead') {
        const { finished } = drawSpriteFrame(
          ctx, deathSheet, wizardX, wizardY, wizardScale,
          wizardPlayheadRef.current, 8, false, true
        );
        if (finished && wizardStateRef.current === 'dying') {
          wizardStateRef.current = 'dead';
          setVillainsDefeated((n) => n + 1);
          setDefeated(true);
        }
      } else if (wizardStateRef.current === 'takeHit') {
        const { finished } = drawSpriteFrame(
          ctx, takeHitSheet, wizardX, wizardY, wizardScale,
          wizardPlayheadRef.current, 10, false, true
        );
        if (finished) {
          wizardStateRef.current = 'idle';
          wizardPlayheadRef.current = 0;
        }
      } else {
        drawSpriteFrame(
          ctx, idleSheet, wizardX, wizardY, wizardScale,
          wizardPlayheadRef.current, 8, true, true
        );
      }

      // Once dead, the orb has nothing to fly at.
      const alive = wizardStateRef.current !== 'dying' && wizardStateRef.current !== 'dead';
      const progress = cameraOn && alive ? progressRef.current : 0;
      const orbX = orbStartX + (orbEndX - orbStartX) * progress;
      drawOrb(ctx, orbX, orbY, progress, t);

      if (impactRef.current) {
        const age = (t - impactRef.current.startedAt) / 500;
        drawImpactBurst(ctx, impactRef.current.x, impactRef.current.y, age);
        if (age >= 1) impactRef.current = null;
      }

      // Health + XP bars. Displayed HP eases toward the real value so
      // damage drains instead of snapping.
      shownHpRef.current += (hpRef.current - shownHpRef.current) * 0.08;
      hitFlashRef.current = Math.max(0, hitFlashRef.current - 0.08);
      drawBossBar(ctx, 'Evil Wizard', shownHpRef.current, hpRef.current, maxHpRef.current, t, hitFlashRef.current);
      const snap = getSnapshot();
      drawXpBar(ctx, snap.level, snap.reps, snap.score);

      // Debug angle readout -- for tuning EXERCISES.rest/peak in
      // engine.js against your actual camera setup (see engine.js's
      // press comment). Drawn directly on canvas since this component
      // has no HTML HUD.
      if (cameraOn) {
        const ex = EXERCISES[sessionRef.current.exerciseKey];
        const live = liveAngleRef.current;
        const text = live == null
          ? `angle: --  (target ${ex.rest}\u00B1${ex.tolerance} / ${ex.peak}\u00B1${ex.tolerance})`
          : `angle: ${Math.round(live)}\u00B0  (target ${ex.rest}\u00B1${ex.tolerance} / ${ex.peak}\u00B1${ex.tolerance})`;
        ctx.save();
        ctx.font = '13px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(text, playerBox.x, playerBox.y - 10);
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sky, main, fg, anyBgFailed, idleSheet, takeHitSheet, deathSheet, cameraOn]);

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
    <div className="w-full">
      <div
        className="w-full relative rounded-2xl overflow-hidden border border-[#E7E2D4] bg-black"
        style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        {!cameraOn && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/50 px-8 text-center">
            {cameraError && (
              <p className="max-w-md text-sm text-[#ffb4b4]">{cameraError}</p>
            )}
            <button
              onClick={startCamera}
              disabled={starting}
              className="font-display px-5 py-2.5 rounded-full bg-[#5CE0A0] text-[#10281c] font-semibold disabled:opacity-60"
            >
              {starting ? 'Starting…' : 'Start camera & cast spells'}
            </button>
          </div>
        )}
        {defeated && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-white text-center gap-3">
            <p className="font-display text-3xl font-semibold">Villain defeated!</p>
            <p className="text-sm text-white/80">
              {villainsDefeated} down · {stats.score} XP · level {stats.level}
            </p>
            <p className="text-xs text-white/60">
              Next one has {Math.min(BASE_VILLAIN_HP + HP_PER_VILLAIN * villainsDefeated, MAX_VILLAIN_HP)} HP
            </p>
            <div className="flex gap-2 mt-1">
              <button
                onClick={nextVillain}
                className="font-display px-4 py-2 rounded-full bg-[#5CE0A0] text-[#10281c] font-semibold"
              >
                Next villain
              </button>
              <button
                onClick={async () => { await handleEndSession(); nextVillain(); }}
                disabled={saving}
                className="font-display px-4 py-2 rounded-full bg-white/15 border border-white/30 disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save session & continue'}
              </button>
            </div>
          </div>
        )}
        <div className="absolute top-3 right-3 flex gap-3 bg-black/50 rounded-xl px-3 py-2 text-white text-xs">
          <span><b>{stats.score}</b> score</span>
          <span><b>{stats.reps}</b> reps</span>
          <span><b>{stats.streak}</b> streak</span>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <span className="text-xs text-[#8D8777] whitespace-nowrap mr-1">Casting exercise:</span>
        {EXERCISE_ORDER.map((key) => (
          <button
            key={key}
            onClick={() => setExercise(key)}
            className={`font-display text-xs px-3 py-1.5 rounded-full transition-colors ${
              exerciseKey === key ? 'bg-[#17140F] text-[#E9E4D6]' : 'bg-white border border-[#E7E2D4] text-[#8D8777]'
            }`}
          >
            {EXERCISES[key].name}
          </button>
        ))}
        <button
          onClick={handleEndSession}
          disabled={saving}
          className="font-display text-xs px-3 py-1.5 rounded-full bg-white border border-[#E7E2D4] text-[#8D8777] ml-auto disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'End session & save'}
        </button>
      </div>
      {saveMsg && <p className="text-xs text-[#8D8777] mt-1">{saveMsg}</p>}
    </div>
  );
}