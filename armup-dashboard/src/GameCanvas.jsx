import { useEffect, useRef, useState } from 'react';
import { EXERCISES } from './engine';
import { apiFetch } from './api';

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

// BASE is './' in the built app, so images resolve inside the Electron window
// (an absolute '/game/...' would point at the drive root under file://).
const BASE = import.meta.env.BASE_URL;
const ASSETS = {
  sky: `${BASE}game/cave-sky.png`,
  main: `${BASE}game/cave-bg.png`,
  fg: `${BASE}game/cave-fg.png`,
  idle: `${BASE}game/wizard/idle.png`,
  takeHit: `${BASE}game/wizard/take-hit.png`,
  death: `${BASE}game/wizard/death.png`,
  attack: `${BASE}game/wizard/attack.png`,
};

// One villain = one guided session (same discipline as Exercise mode).
// Every correct rep is 1 damage; the session saves itself when the villain
// falls. Retreating early saves only if you landed MIN_SAVE_REPS hits.
const MIN_SAVE_REPS = 5;
const COUNTDOWN_SECS = 3;
const REPS_PER_LEVEL = 5; // matches SessionState._maybeLevelUp in engine.js
const HP_PER_ROUND = 2;   // each full campaign run makes every villain a bit tougher
const MAX_HP = 16;
const MAX_BOSS_HP = 20;

// Same wizard sprite, recoloured with a canvas filter -- no new artwork needed.
// Each villain is weak to one exercise, so the campaign walks through all four.
const VILLAINS = [
  { id: 'wizard', name: 'Evil Wizard', exercise: 'curl', hp: 10, scale: 2, filter: 'none',
    taunt: 'You dare enter my cave?' },
  { id: 'frost', name: 'Frost Warlock', exercise: 'raise', hp: 10, scale: 2,
    filter: 'hue-rotate(150deg) saturate(1.2)', taunt: 'Your arms will freeze before mine!' },
  { id: 'ember', name: 'Ember Mage', exercise: 'press', hp: 10, scale: 2,
    filter: 'hue-rotate(-50deg) saturate(1.6) brightness(1.1)', taunt: 'Feel the heat of my fire!' },
  { id: 'shade', name: 'Shadow Hexer', exercise: 'neck_tilt', hp: 10, scale: 2,
    filter: 'hue-rotate(250deg) brightness(0.55) saturate(1.3)', taunt: 'Shadows cannot be stretched away...' },
  { id: 'archlich', name: 'The Archlich', exercise: 'press', hp: 14, scale: 2.5, boss: true,
    filter: 'hue-rotate(80deg) brightness(0.75) saturate(1.8)', taunt: 'Bow before the Archlich!' },
];

const progressKey = (userId) => `armup.game.progress.${userId ?? 'guest'}`;
function loadProgress(userId) {
  try {
    const p = JSON.parse(localStorage.getItem(progressKey(userId)) || 'null');
    if (p && Number.isInteger(p.index) && Number.isInteger(p.round)) {
      return { index: Math.min(Math.max(p.index, 0), VILLAINS.length - 1), round: Math.max(p.round, 0) };
    }
  } catch { /* storage unavailable -- start fresh */ }
  return { index: 0, round: 0 };
}
function saveProgress(userId, p) {
  try { localStorage.setItem(progressKey(userId), JSON.stringify(p)); } catch { /* ignore */ }
}
const villainHp = (v, round) => Math.min(v.hp + HP_PER_ROUND * round, v.boss ? MAX_BOSS_HP : MAX_HP);

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

function drawDamageNumber(ctx, x, y, age, text) {
  if (age >= 1) return;
  ctx.save();
  ctx.globalAlpha = 1 - age;
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(20,8,30,0.8)';
  ctx.strokeText(text, x, y - age * 60);
  ctx.fillStyle = '#ffd36b';
  ctx.fillText(text, x, y - age * 60);
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
function drawBossBar(ctx, name, shown, hp, maxHp, t, flash, boss) {
  const w = 360, h = 20, x = (CANVAS_W - w) / 2, y = 34;
  ctx.save();
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${boss ? '\u2605 ' : ''}${name}  ${hp}/${maxHp}`, CANVAS_W / 2, y - 8);

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

export default function GameCanvas({ pose, userId, onSessionSaved }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const [saving, setSaving] = useState(false);

  const {
    poseCanvasRef, progressRef, liveAngleRef, sessionRef,
    setExercise,
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
  const attackSheet = useSpriteSheet(ASSETS.attack, 150, 150, 8);

  // Campaign: which villain is next, and how many full runs are done.
  const [progress, setProgress] = useState(() => loadProgress(userId));
  const villain = VILLAINS[progress.index];
  const maxHp = villainHp(villain, progress.round);

  // Battle flow: idle -> countdown -> fighting -> complete
  const [phase, setPhase] = useState('idle');
  const [count, setCount] = useState(COUNTDOWN_SECS);
  const [confirmStop, setConfirmStop] = useState(false);
  const [result, setResult] = useState(null);
  const finishedRef = useRef(false);   // guards against saving one fight twice

  // Mirrors of React state, read every frame / in event handlers.
  const phaseRef = useRef('idle');
  const villainRef = useRef(villain);
  useEffect(() => { phaseRef.current = phase; villainRef.current = villain; });

  // Fight state lives in refs (read every frame by the draw loop).
  const hpRef = useRef(maxHp);
  const maxHpRef = useRef(maxHp);
  const shownHpRef = useRef(maxHp);   // smoothed, for the drain animation
  const hitFlashRef = useRef(0);
  const wizardStateRef = useRef('idle'); // 'idle' | 'takeHit' | 'attack' | 'dying' | 'dead'
  const wizardPlayheadRef = useRef(0);
  const nextAttackAtRef = useRef(0);
  const lastFrameTimeRef = useRef(null);
  const impactRef = useRef(null);
  const dmgNumsRef = useRef([]);
  const finalStatsRef = useRef(null);  // frozen at the killing blow

  // Each villain is weak to one exercise -- lock the camera session to it.
  useEffect(() => {
    if (phase === 'idle') setExercise(villain.exercise);
  }, [villain, phase, setExercise]);

  // Put the health bar back to full whenever a new fight is set up.
  const resetFight = () => {
    hpRef.current = maxHp;
    maxHpRef.current = maxHp;
    shownHpRef.current = maxHp;
    wizardStateRef.current = 'idle';
    wizardPlayheadRef.current = 0;
    nextAttackAtRef.current = performance.now() + 4000;
    dmgNumsRef.current = [];
    impactRef.current = null;
  };

  // Keep the idle-screen bar in sync with the chosen villain.
  useEffect(() => {
    if (phase === 'idle') {
      hpRef.current = maxHp; maxHpRef.current = maxHp; shownHpRef.current = maxHp;
      wizardStateRef.current = 'idle';
    }
  }, [phase, maxHp, villain]);

  const orbStartX = 260;
  const orbEndX = CANVAS_W - 260;
  const orbY = CANVAS_H - 150;
  const playerBox = { x: 60, y: CANVAS_H - 260, w: 220, h: 260 };

  // A correct rep = one hit, but only while a fight is actually running.
  const landHit = () => {
    if (phaseRef.current !== 'fighting') return;
    if (wizardStateRef.current === 'dying' || wizardStateRef.current === 'dead') return;
    hpRef.current = Math.max(0, hpRef.current - 1);
    wizardPlayheadRef.current = 0;
    hitFlashRef.current = 1;
    const now = performance.now();
    impactRef.current = { x: orbEndX, y: orbY, startedAt: now };
    const streak = getSnapshot().streak;
    dmgNumsRef.current.push({ x: orbEndX + 40, y: orbY - 70, startedAt: now, text: streak >= 5 ? '-1 COMBO!' : '-1' });
    if (hpRef.current === 0) {
      finalStatsRef.current = getSnapshot();   // freeze the numbers at the killing blow
      wizardStateRef.current = 'dying';
    } else {
      wizardStateRef.current = 'takeHit';
    }
  };

  // The hook keeps its last feedback event around, so only react to events
  // newer than mount (otherwise a stale rep from Exercise mode would hit).
  const lastFeedbackAtRef = useRef(feedback?.at ?? null);
  useEffect(() => {
    if (!feedback || feedback.at === lastFeedbackAtRef.current) return;
    lastFeedbackAtRef.current = feedback.at;
    if (feedback.event === 'rep_complete') landHit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedback]);

  // 3-2-1 countdown, then the fight begins with fresh counters.
  useEffect(() => {
    if (phase !== 'countdown') return;
    const id = setTimeout(() => {
      if (count <= 1) {
        resetStats();
        resetFight();
        finishedRef.current = false;
        setPhase('fighting');
      } else {
        setCount(count - 1);
      }
    }, 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, count]);

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
          form_faults: final.formFaults || {},
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

  // Ends the fight. A win always saves; a retreat saves only if it reached
  // MIN_SAVE_REPS, so a couple of stray reps never become a session.
  const finishBattle = async (final, won) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const v = villainRef.current;
    const exKey = sessionRef.current.exerciseKey;
    const frozen = { ...final, reps: won ? Math.min(final.reps, maxHpRef.current) : final.reps };
    const willSave = won || frozen.reps >= MIN_SAVE_REPS;
    setConfirmStop(false);
    setPhase('complete');
    setResult({ ...frozen, exerciseKey: exKey, won, villainName: v.name, boss: !!v.boss, total: maxHpRef.current, discarded: !willSave, saved: null });
    if (won) {
      // Advance the campaign only when the villain actually falls.
      const nextIndex = progress.index + 1;
      const next = nextIndex >= VILLAINS.length
        ? { index: 0, round: progress.round + 1 }
        : { index: nextIndex, round: progress.round };
      saveProgress(userId, next);
      setNextProgress(next);
    }
    if (willSave) {
      const saved = await postSession(frozen, exKey);
      setResult((r) => (r ? { ...r, saved } : r));
    }
  };
  const [nextProgress, setNextProgress] = useState(null);
  const finishBattleRef = useRef(finishBattle);
  useEffect(() => { finishBattleRef.current = finishBattle; });

  const retrySave = async () => {
    if (!result) return;
    const saved = await postSession(result, result.exerciseKey);
    setResult((r) => (r ? { ...r, saved } : r));
  };

  const startBattle = () => {
    setResult(null);
    setNextProgress(null);
    setConfirmStop(false);
    resetFight();
    setCount(COUNTDOWN_SECS);
    setPhase('countdown');
  };
  const cancelCountdown = () => setPhase('idle');

  // After a win: move on to the next villain. (A retreat just lets you retry.)
  const goNextVillain = () => {
    if (nextProgress) setProgress(nextProgress);
    setNextProgress(null);
    setResult(null);
    setPhase('idle');
  };
  const backToStart = () => { setResult(null); setNextProgress(null); setPhase('idle'); };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const loop = (t) => {
      if (lastFrameTimeRef.current == null) lastFrameTimeRef.current = t;
      const dt = t - lastFrameTimeRef.current;
      lastFrameTimeRef.current = t;
      wizardPlayheadRef.current += dt;

      const v = villainRef.current;
      const drawSize = 150 * v.scale;
      const wizardX = 770 - drawSize / 2;
      const wizardY = CANVAS_H - drawSize;

      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      drawBackground(ctx, sky, main, fg, anyBgFailed, t);

      drawPlayerBox(ctx, poseCanvasRef.current, playerBox.x, playerBox.y, playerBox.w, playerBox.h, cameraOn);

      // Villain sprite, tinted per villain via the canvas filter.
      ctx.save();
      ctx.filter = v.filter;
      const state = wizardStateRef.current;
      if (state === 'dying' || state === 'dead') {
        const { finished } = drawSpriteFrame(
          ctx, deathSheet, wizardX, wizardY, v.scale, wizardPlayheadRef.current, 8, false, true
        );
        if (finished && state === 'dying') {
          wizardStateRef.current = 'dead';
          finishBattleRef.current(finalStatsRef.current || getSnapshot(), true);
        }
      } else if (state === 'takeHit') {
        const { finished } = drawSpriteFrame(
          ctx, takeHitSheet, wizardX, wizardY, v.scale, wizardPlayheadRef.current, 10, false, true
        );
        if (finished) { wizardStateRef.current = 'idle'; wizardPlayheadRef.current = 0; }
      } else if (state === 'attack') {
        const { finished } = drawSpriteFrame(
          ctx, attackSheet, wizardX, wizardY, v.scale, wizardPlayheadRef.current, 10, false, true
        );
        if (finished) {
          wizardStateRef.current = 'idle';
          wizardPlayheadRef.current = 0;
          nextAttackAtRef.current = t + 5000 + Math.random() * 3000;
        }
      } else {
        drawSpriteFrame(
          ctx, idleSheet, wizardX, wizardY, v.scale, wizardPlayheadRef.current, 8, true, true
        );
        // Purely cosmetic taunt: the villain swings at you now and then.
        if (phaseRef.current === 'fighting' && t > nextAttackAtRef.current) {
          wizardStateRef.current = 'attack';
          wizardPlayheadRef.current = 0;
        }
      }
      ctx.restore();

      // Once dead, the orb has nothing to fly at.
      const alive = wizardStateRef.current !== 'dying' && wizardStateRef.current !== 'dead';
      const fighting = phaseRef.current === 'fighting';
      const progressVal = cameraOn && alive && fighting ? progressRef.current : 0;
      const orbX = orbStartX + (orbEndX - orbStartX) * progressVal;
      drawOrb(ctx, orbX, orbY, progressVal, t);

      if (impactRef.current) {
        const age = (t - impactRef.current.startedAt) / 500;
        drawImpactBurst(ctx, impactRef.current.x, impactRef.current.y, age);
        if (age >= 1) impactRef.current = null;
      }
      dmgNumsRef.current = dmgNumsRef.current.filter((d) => {
        const age = (performance.now() - d.startedAt) / 800;
        drawDamageNumber(ctx, d.x, d.y, age, d.text);
        return age < 1;
      });

      shownHpRef.current += (hpRef.current - shownHpRef.current) * 0.08;
      hitFlashRef.current = Math.max(0, hitFlashRef.current - 0.08);
      drawBossBar(ctx, v.name, shownHpRef.current, hpRef.current, maxHpRef.current, t, hitFlashRef.current, v.boss);
      const snap = getSnapshot();
      drawXpBar(ctx, snap.level, snap.reps, snap.score);

      // Debug angle readout -- for tuning EXERCISES.rest/peak in engine.js.
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
  }, [sky, main, fg, anyBgFailed, idleSheet, takeHitSheet, deathSheet, attackSheet, cameraOn]);

  const exName = EXERCISES[villain.exercise].name;
  const shown = phase === 'complete' && result ? result : stats;
  const btnPrimary = 'font-display px-5 py-2.5 rounded-full bg-[#5CE0A0] text-[#10281c] font-semibold disabled:opacity-60';
  const btnGhost = 'font-display px-4 py-2 rounded-full bg-white/15 border border-white/30 disabled:opacity-60';

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
            {cameraError && <p className="max-w-md text-sm text-[#ffb4b4]">{cameraError}</p>}
            <button onClick={startCamera} disabled={starting} className={btnPrimary}>
              {starting ? 'Starting…' : 'Start camera & cast spells'}
            </button>
          </div>
        )}

        {cameraOn && phase === 'idle' && (
          <div className="absolute inset-x-0 bottom-6 flex justify-center px-4">
            <div className="w-full max-w-md bg-[#241832]/95 border border-white/20 rounded-2xl px-5 py-4 text-center text-white flex flex-col items-center gap-1.5">
              <p className="font-display text-lg font-semibold">
                {villain.boss ? '\u2605 Boss: ' : ''}{villain.name}
              </p>
              <p className="text-xs italic text-white/70">“{villain.taunt}”</p>
              <p className="text-xs text-white/80">
                Weak to <b>{exName}</b> · {maxHp} hits to defeat
              </p>
              <button onClick={startBattle} className={`${btnPrimary} mt-1`}>Start battle</button>
            </div>
          </div>
        )}

        {phase === 'countdown' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white pointer-events-none" style={{ textShadow: '0 2px 12px #000a' }}>
            <span className="text-[110px] font-extrabold leading-none">{count}</span>
            <p className="text-base mt-1">Get into position — {exName}</p>
          </div>
        )}

        {phase === 'fighting' && (
          <div className="absolute left-3 right-3 bottom-3 pointer-events-none">
            <div className="text-xs font-semibold text-white mb-1" style={{ textShadow: '0 1px 3px #000a' }}>
              Hit {Math.min(stats.reps, maxHp)} of {maxHp}
            </div>
            <div className="h-2.5 bg-white/25 rounded-md overflow-hidden">
              <div className="h-full bg-[#5CE0A0] rounded-md transition-all" style={{ width: `${Math.min(100, (stats.reps / maxHp) * 100)}%` }} />
            </div>
          </div>
        )}

        {confirmStop && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm bg-[#241832] border border-white/20 rounded-2xl p-5 text-center text-white">
              <h3 className="font-display text-xl font-semibold mb-1">Retreat from this fight?</h3>
              <p className="text-sm text-white/75">
                {stats.reps >= MIN_SAVE_REPS
                  ? `You've landed ${stats.reps} of ${maxHp} hits. They'll be saved as a shorter session.`
                  : `You've landed ${stats.reps} of ${maxHp} hits. It takes at least ${MIN_SAVE_REPS} to save a session, so this one won't be saved.`}
              </p>
              <div className="flex gap-2 justify-center mt-4">
                <button onClick={() => setConfirmStop(false)} className={btnPrimary}>Keep fighting</button>
                <button onClick={() => finishBattle(getSnapshot(), false)} className={btnGhost}>Retreat</button>
              </div>
            </div>
          </div>
        )}

        {phase === 'complete' && result && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/65 p-4">
            <div className="w-full max-w-md bg-[#241832] border border-white/20 rounded-2xl p-5 text-center text-white">
              <h3 className="font-display text-2xl font-semibold">
                {result.won ? (result.boss ? 'Boss defeated!' : 'Villain defeated!') : result.discarded ? 'Fight not saved' : 'You retreated'}
              </h3>
              <p className="text-sm text-white/70 mb-3">
                {result.villainName} · {result.reps} of {result.total} hits
              </p>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {[['Score', result.score], ['Accuracy', `${result.accuracy}%`], ['Best streak', result.maxStreak], ['Level', result.level]].map(([lbl, val]) => (
                  <div key={lbl} className="bg-white/10 rounded-xl py-2.5 flex flex-col">
                    <b className="text-xl text-[#3FE0D0]">{val}</b>
                    <span className="text-[10px] uppercase text-white/60">{lbl}</span>
                  </div>
                ))}
              </div>
              <p className="text-sm text-white/80">
                {result.discarded
                  ? `Fewer than ${MIN_SAVE_REPS} hits, so nothing was recorded.`
                  : saving || result.saved === null
                    ? 'Saving your session…'
                    : result.saved ? 'Saved to your session log.' : "Couldn't save this session."}
              </p>
              {result.won && nextProgress && (
                <p className="text-xs text-white/60 mt-1">
                  Up next: {VILLAINS[nextProgress.index].name}
                  {nextProgress.index === 0 && nextProgress.round > progress.round ? ' (campaign complete — harder round!)' : ''}
                </p>
              )}
              <div className="flex gap-2 justify-center flex-wrap mt-4">
                {!result.discarded && result.saved === false && (
                  <button onClick={retrySave} disabled={saving} className={btnGhost}>Try saving again</button>
                )}
                {result.won ? (
                  <>
                    <button onClick={goNextVillain} className={btnPrimary}>Next villain</button>
                    <button onClick={() => { setNextProgress(null); setResult(null); setPhase('idle'); }} className={btnGhost}>Rematch</button>
                  </>
                ) : (
                  <button onClick={backToStart} className={btnPrimary}>Fight again</button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="absolute top-3 right-3 flex gap-3 bg-black/50 rounded-xl px-3 py-2 text-white text-xs">
          <span><b>{shown.score}</b> score</span>
          <span><b>{shown.reps}</b> reps</span>
          <span><b>{shown.streak}</b> streak</span>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <span className="text-xs text-[#8D8777] whitespace-nowrap mr-1">
          Campaign{progress.round > 0 ? ` · round ${progress.round + 1}` : ''}:
        </span>
        {VILLAINS.map((v, i) => {
          const done = i < progress.index;
          const current = i === progress.index;
          return (
            <span
              key={v.id}
              className={`font-display text-xs px-3 py-1.5 rounded-full ${
                current ? 'bg-[#17140F] text-[#E9E4D6]'
                  : done ? 'bg-[#E3F4EA] border border-[#BFE3CD] text-[#2f6b4a]'
                    : 'bg-white border border-[#E7E2D4] text-[#B5AF9F]'
              }`}
            >
              {done ? '\u2713 ' : v.boss ? '\u2605 ' : ''}{v.name}
            </span>
          );
        })}
        {phase === 'countdown' && (
          <button onClick={cancelCountdown} className="font-display text-xs px-3 py-1.5 rounded-full bg-white border border-[#E7E2D4] text-[#8D8777] ml-auto">
            Cancel
          </button>
        )}
        {phase === 'fighting' && (
          <button onClick={() => setConfirmStop(true)} className="font-display text-xs px-3 py-1.5 rounded-full bg-white border border-[#E7E2D4] text-[#8D8777] ml-auto">
            Retreat
          </button>
        )}
      </div>
    </div>
  );
}