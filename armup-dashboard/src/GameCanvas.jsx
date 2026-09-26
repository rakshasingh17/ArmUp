import React, { useEffect, useRef, useState } from 'react';

/*
 * GameCanvas
 * ----------
 * The render loop for the "spell battle" game mode. Draw order:
 *   1. Background -- 3-layer parallax: a flat sky color (static), the
 *      main cave art (static), and one foreground rock-silhouette layer
 *      that scrolls slowly for depth. All three are real assets under
 *      /public/game/ (CC-0 pack). Falls back to a coded gradient if any
 *      of them fail to load, so this never breaks.
 *   2. Evil Wizard -- real sprite sheets (idle.png / take-hit.png),
 *      150x150 frames. Idle loops continuously; when a spell lands
 *      (progress hits 1) it switches to the Take Hit animation for one
 *      playthrough, then returns to idle. attack.png / move.png /
 *      death.png are copied into public/game/wizard/ but not wired up
 *      yet -- attack.png is the natural next step once there's a player
 *      "cast" action to trigger it, and death.png once there's a health/
 *      win condition.
 *   3. Orb -- fully coded (radial gradient + particles), reacts live to
 *      `progress` (0..1). No asset needed.
 *
 * `progress` is currently driven by a debug slider so the loop can be
 * seen working before real camera/rep data exists. Swap the slider for
 * a prop (e.g. the exercise engine's rep-hold percentage) when wiring
 * to the camera -- nothing else in this file needs to change.
 */

const CANVAS_W = 960;
const CANVAS_H = 540;

const ASSETS = {
  sky: '/game/cave-sky.png',
  main: '/game/cave-bg.png',
  fg: '/game/cave-fg.png',
  idle: '/game/wizard/idle.png',
  takeHit: '/game/wizard/take-hit.png',
};

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

// Generic sprite-sheet handle: frames laid out left-to-right in one row,
// all the same size (true for every sheet in this pack -- 150x150).
function useSpriteSheet(src, frameW, frameH, frameCount) {
  const [img] = useImage(src);
  return { img, frameW, frameH, frameCount };
}

/*
 * Draws one frame of a sprite sheet. `playhead` is elapsed ms since the
 * animation (re)started; `fps` controls playback speed. `loop=false`
 * clamps on the last frame instead of wrapping, and returns whether the
 * animation has finished (useful for one-shot clips like Take Hit).
 */
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
  // Used only if the real assets fail to load (e.g. wrong path).
  const g = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  g.addColorStop(0, '#241832');
  g.addColorStop(1, '#0d0714');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '12px monospace';
  ctx.fillText('(cave assets not found -- check /public/game/)', 14, CANVAS_H - 14);
}

// Tiles a background image horizontally at a given scroll offset, so a
// single 384x216 layer can scroll infinitely without a visible seam.
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
  // Sky: flat color layer, stretched to fill and static (it's a solid
  // fill, scrolling it would do nothing visible anyway).
  if (sky) ctx.drawImage(sky, 0, 0, CANVAS_W, CANVAS_H);

  // Main cave art: the detailed midground, scaled up from 384x216 and
  // held static -- this alone already reads as a complete background.
  if (main) {
    const scale = CANVAS_W / main.width;
    ctx.drawImage(main, 0, CANVAS_H - main.height * scale, CANVAS_W, main.height * scale);
  }

  // Foreground silhouette: scrolls slowly left, tiled seamlessly. This
  // is the cheap "looks way more alive than it should" parallax trick --
  // pure visual polish, the game logic doesn't depend on it.
  if (fg) {
    const scale = (CANVAS_W / fg.width) * 1.05; // slightly oversized so tiling seams sit off-canvas
    drawScrollingLayer(ctx, fg, t / 40, scale);
  }

  if (anyFailed) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '12px monospace';
    ctx.fillText('(one or more cave layers failed to load -- check /public/game/)', 14, CANVAS_H - 14);
  }
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

// Coded impact burst for the moment the spell lands -- no sprite asset
// needed, matches the plan to skip searching for a hit-effect sheet.
function drawImpactBurst(ctx, x, y, age) {
  // age: 0 (just landed) .. 1 (fully faded)
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

export default function GameCanvas() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const [progress, setProgress] = useState(0);

  const [sky, skyFailed] = useImage(ASSETS.sky);
  const [main, mainFailed] = useImage(ASSETS.main);
  const [fg, fgFailed] = useImage(ASSETS.fg);
  const anyBgFailed = skyFailed || mainFailed || fgFailed;

  const idleSheet = useSpriteSheet(ASSETS.idle, 150, 150, 8);
  const takeHitSheet = useSpriteSheet(ASSETS.takeHit, 150, 150, 4);

  // Wizard animation state lives in refs -- the render loop mutates it
  // every frame without going through React state/re-renders.
  const wizardStateRef = useRef('idle'); // 'idle' | 'takeHit'
  const wizardPlayheadRef = useRef(0);
  const lastFrameTimeRef = useRef(null);
  const impactRef = useRef(null); // {x, y, startedAt} | null

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const orbStartX = 260;
    const orbEndX = CANVAS_W - 260;
    const orbY = CANVAS_H - 150;
    const wizardX = CANVAS_W - 340;
    const wizardY = CANVAS_H - 300;
    const wizardScale = 2;

    const loop = (t) => {
      if (lastFrameTimeRef.current == null) lastFrameTimeRef.current = t;
      const dt = t - lastFrameTimeRef.current;
      lastFrameTimeRef.current = t;
      wizardPlayheadRef.current += dt;

      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      drawBackground(ctx, sky, main, fg, anyBgFailed, t);

      // Player placeholder -- swap for the real webcam <video> frame
      // (drawImage(videoEl, ...) into this same canvas) once wired up.
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(60, CANVAS_H - 260, 220, 260);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '13px sans-serif';
      ctx.fillText('webcam feed goes here', 68, CANVAS_H - 270);
      ctx.restore();

      // Wizard: idle loops forever; take-hit plays once then falls back.
      if (wizardStateRef.current === 'takeHit') {
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

      // Orb travels from the player toward the wizard as progress rises.
      const orbX = orbStartX + (orbEndX - orbStartX) * progress;
      drawOrb(ctx, orbX, orbY, progress, t);

      if (impactRef.current) {
        const age = (t - impactRef.current.startedAt) / 500; // 500ms burst
        drawImpactBurst(ctx, impactRef.current.x, impactRef.current.y, age);
        if (age >= 1) impactRef.current = null;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [progress, sky, main, fg, anyBgFailed, idleSheet, takeHitSheet]);

  const triggerLanding = () => {
    wizardStateRef.current = 'takeHit';
    wizardPlayheadRef.current = 0;
    impactRef.current = { x: CANVAS_W - 260, y: CANVAS_H - 150, startedAt: performance.now() };
  };

  const handleSliderChange = (e) => {
    const v = Number(e.target.value) / 100;
    const wasBelow = progress < 1;
    setProgress(v);
    if (v >= 1 && wasBelow) {
      triggerLanding();
      setTimeout(() => setProgress(0), 500);
    }
  };

  return (
    <div className="w-full">
      <div
        className="w-full rounded-2xl overflow-hidden border border-[#E7E2D4] bg-black"
        style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
      </div>
      <div className="flex items-center gap-3 mt-3">
        <span className="text-xs text-[#8D8777] whitespace-nowrap">
          Test progress (fake -- replace with real rep engine value)
        </span>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(progress * 100)}
          onChange={handleSliderChange}
          className="w-full"
        />
        <span className="text-xs font-mono text-[#221E18] w-10 text-right">
          {Math.round(progress * 100)}%
        </span>
      </div>
    </div>
  );
}