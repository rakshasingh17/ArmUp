/*
 * koiGame.js
 * ----------
 * The pond for "Koi chase" -- a calm, no-fail reaching game. Everything is
 * drawn in code (no image or sound files), so it works fully offline.
 *
 * It knows nothing about React or MediaPipe. The caller hands it:
 *   getHand()    -> { x, y, px, py } | null
 *                   x,y   = hand position in the pond, 0..1
 *                   px,py = same wrist in the camera preview, 0..1 (for the dot)
 *                   null  = no hand visible right now
 *   getPreview() -> the mirrored camera canvas (small thumbnail), or null
 *   onBloom(n)   -> called with the running bloom count
 *
 * Flowers come in three colours worth 1 / 2 / 3 points (rarer = worth more,
 * and gold ones appear further away). Several buds are open at once. In
 * Active mode a slow rival koi may snatch a bud; it never takes points away
 * and there is still no fail state.
 */

export const KOI_W = 960;
export const KOI_H = 540;

const W = KOI_W, H = KOI_H, S = KOI_H;
const TAU = Math.PI * 2;
const R = Math.random;
const N = 18;               // koi body segments
const SEG = S * 0.022;      // length of one segment
const THUMB = { x: 14, w: 176 };

// Calm mode is the default: slower koi, bigger catch area, no combo, no timers.
export const MODES = {
  calm:   { k: 3.6, damp: 3,   max: 0.9, catch: 0.085, lo: 0.16, hi: 0.24, grow: 0.008, combo: false, sparks: 14, gain: 0.08, ui: 1.25, buds: 2, rival: false, expire: false },
  active: { k: 9,   damp: 4.5, max: 1.8, catch: 0.06,  lo: 0.22, hi: 0.3,  grow: 0.014, combo: true,  sparks: 34, gain: 0.12, ui: 1,    buds: 3, rival: true,  expire: true },
};

// Flower colours. `pts` is what a bloom is worth; the rest is paint.
export const KINDS = { pink: { pts: 1 }, lilac: { pts: 2 }, gold: { pts: 3 } };
const PALETTES = {
  pink:  { core: '#fff0f6', mid: '#ffb0cf', tip: '#ff5fa2', mid2: '#ff9cc4', tip2: '#ff7db5', glow: '255,170,215', ring: '255,220,240', burst: ['255,170,210', '255,235,160'] },
  lilac: { core: '#f4efff', mid: '#cdb8ff', tip: '#8f6bff', mid2: '#bca4ff', tip2: '#a587ff', glow: '190,160,255', ring: '225,210,255', burst: ['190,160,255', '230,215,255'] },
  gold:  { core: '#fffbe6', mid: '#ffe27a', tip: '#ffb300', mid2: '#ffd95e', tip2: '#ffc21f', glow: '255,215,100', ring: '255,240,180', burst: ['255,215,100', '255,245,190'] },
};
const LOOK = {
  player: { tail: 'rgba(255,160,110,.42)', fin: 'rgba(255,185,140,.55)', base: '#fff3e4',
    spots: [[1, 0.95, '#ff4a1c'], [2, 0.8, '#ff5a1f'], [5, 1.15, '#e8321a'], [8, 1.2, '#ff7a2f'], [11, 1.05, '#ff5a1f'], [14, 0.8, '#23232b']] },
  rival: { tail: 'rgba(130,175,255,.42)', fin: 'rgba(160,195,255,.55)', base: '#e9f1ff',
    spots: [[1, 0.95, '#2f5fc4'], [2, 0.8, '#3a6fd8'], [5, 1.15, '#24479a'], [8, 1.2, '#4a7fe0'], [11, 1.05, '#3a6fd8'], [14, 0.8, '#1a1f3a']] },
};

// Which colour the next flower is. `r` is a random number 0..1. The first
// few flowers are always pink so a new patient starts easy.
export function pickKind(r, blooms) {
  if (blooms < 3) return 'pink';
  if (r < 0.12) return 'gold';
  if (r < 0.37) return 'lilac';
  return 'pink';
}

function makeKoi(x, y) {
  const k = { p: [], vx: 0, vy: 0, sp: 0 };
  for (let i = 0; i < N; i++) k.p.push({ x: x - i * SEG, y });
  return k;
}

export function createKoiGame(canvas, { getHand, getPreview, onBloom } = {}) {
  const g = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  let M = MODES.calm;
  const opts = { reach: 1 };
  const hand = { x: W / 2, y: H / 2, seen: -1e9, px: null, py: null };
  const koi = makeKoi(W / 2, H / 2);
  const rival = makeKoi(W * 0.85, H * 0.18);
  const rv = { on: false, delay: 6, cool: 0, stolen: 0, rt: 0 };

  const buds = [], garden = [], ripples = [], parts = [];
  let blooms = 0, points = 0, combo = 0, maxCombo = 0, lastBloom = -99, light = 0, t = 0, rippleT = 0, hintA = 1;
  let raf = 0, last = 0, ac = null, destroyed = false;

  const pads = Array.from({ length: 9 }, () => ({ x: R(), y: R(), r: 0.03 + R() * 0.035, a: R() * TAU, n: R() * TAU }));
  const flies = Array.from({ length: 26 }, () => ({ x: R(), y: R(), sx: 0.1 + R() * 0.2, sy: 0.1 + R() * 0.2, ph: R() * TAU, bl: 0.8 + R() * 1.6 }));

  // ---- sound (soft sine chimes; needs one click first, see unlockAudio)
  function unlockAudio() {
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
    } catch { ac = null; }
  }
  function chime(n) {
    if (!ac) return;
    const f = [523.25, 587.33, 659.25, 783.99, 880, 1046.5][n % 6], at = ac.currentTime;
    [1, 2.01].forEach((m, i) => {
      const o = ac.createOscillator(), v = ac.createGain();
      o.type = 'sine'; o.frequency.value = f * m;
      v.gain.setValueAtTime(0, at);
      v.gain.linearRampToValueAtTime(M.gain / (i + 1), at + 0.02);
      v.gain.exponentialRampToValueAtTime(0.001, at + 1.4);
      o.connect(v).connect(ac.destination);
      o.start(at); o.stop(at + 1.5);
    });
  }

  // ---- buds
  function spawn() {
    const h = koi.p[0], m = S * 0.1, kind = pickKind(R(), blooms);
    let lo = S * M.lo * opts.reach, hi = S * (M.hi + Math.min(blooms, 25) * M.grow) * opts.reach;
    if (kind === 'gold') { lo = (lo + hi) / 2; hi *= 1.25; } // gold is worth a longer reach
    const mk = (x, y) => ({ x, y, st: 0, open: 0.1, t: 0, rot: R() * TAU, kind });
    for (let k = 0; k < 40; k++) {
      const a = R() * TAU, d = lo + R() * (hi - lo);
      const x = h.x + Math.cos(a) * d, y = h.y + Math.sin(a) * d;
      if (x < m || x > W - m || y < m * 1.6 || y > H - m) continue;
      if (x < THUMB.x + THUMB.w + 40 && y > H - 170) continue; // keep clear of the camera thumbnail
      if (buds.some((b) => Math.hypot(b.x - x, b.y - y) < S * 0.2)) continue;
      buds.push(mk(x, y));
      return;
    }
    buds.push(mk(W * (0.3 + R() * 0.45), H * (0.3 + R() * 0.4)));
  }
  // Keep the right number of open buds in the pond.
  function fill() {
    let n = buds.filter((b) => b.st === 0).length;
    while (n++ < M.buds) spawn();
  }
  fill();

  function burst(x, y, n, pal) {
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, s = S * (0.05 + R() * 0.25);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, l: 0, m: 0.9 + R() * 0.9, s: S * (0.004 + R() * 0.007), c: R() < 0.6 ? pal.burst[0] : pal.burst[1] });
    }
  }

  // ---- drawing helpers
  function glow(x, y, r, c, a) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${c},${a})`); gr.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function lotus(x, y, r, open, al, rot, pal = PALETTES.pink) {
    g.save(); g.translate(x, y); g.rotate(rot); g.globalAlpha = al;
    [[8, 1, 0], [8, 0.8, TAU / 16], [6, 0.58, TAU / 12]].forEach(([n, sc, off], li) => {
      const len = r * sc * (0.45 + 0.55 * open), w = r * sc * (0.15 + 0.21 * open);
      for (let i = 0; i < n; i++) {
        g.save(); g.rotate((i / n) * TAU + off);
        const gr = g.createLinearGradient(0, 0, 0, -len);
        gr.addColorStop(0, li === 2 ? '#ffe9a8' : pal.core);
        gr.addColorStop(0.55, li === 0 ? pal.mid : pal.mid2);
        gr.addColorStop(1, li === 0 ? pal.tip : pal.tip2);
        g.fillStyle = gr; g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, 0);
        g.bezierCurveTo(-w, -len * 0.35, -w * 0.9, -len * 0.85, 0, -len);
        g.bezierCurveTo(w * 0.9, -len * 0.85, w, -len * 0.35, 0, 0);
        g.fill(); g.stroke(); g.restore();
      }
    });
    g.fillStyle = '#ffd45e'; g.beginPath(); g.arc(0, 0, r * 0.13, 0, TAU); g.fill();
    g.fillStyle = '#f0a020';
    for (let i = 0; i < 8; i++) { g.beginPath(); g.arc(Math.cos(i * 0.785) * r * 0.09, Math.sin(i * 0.785) * r * 0.09, r * 0.018, 0, TAU); g.fill(); }
    g.restore();
  }

  // ---- koi
  function bodyPts(k) {
    const q = [], amp = S * 0.012 * (0.5 + Math.min(k.sp / S, 1) * 1.2), P = k.p;
    for (let i = 0; i < N; i++) {
      const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, N - 1)];
      let tx = b.x - a.x, ty = b.y - a.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const sw = Math.sin(t * 5 - i * 0.55) * (i / N) * amp;
      q.push({ x: P[i].x - ty * sw, y: P[i].y + tx * sw, nx: -ty, ny: tx, tx, ty });
    }
    return q;
  }
  const widthAt = (i) => { const k = i / (N - 1), m = S * 0.03; return m * Math.max(0.05, k < 0.2 ? 0.55 + k * 2.2 : Math.pow(1 - (k - 0.2) / 0.8, 0.9)); };
  function bodyPath(q, ox = 0, oy = 0) {
    g.beginPath(); const h = q[0];
    g.moveTo(h.x - h.tx * S * 0.016 + ox, h.y - h.ty * S * 0.016 + oy);
    for (let i = 0; i < N; i++) { const w = widthAt(i); g.lineTo(q[i].x + q[i].nx * w + ox, q[i].y + q[i].ny * w + oy); }
    for (let i = N - 1; i >= 0; i--) { const w = widthAt(i); g.lineTo(q[i].x - q[i].nx * w + ox, q[i].y - q[i].ny * w + oy); }
    g.closePath();
  }
  function drawKoi(k = koi, look = LOOK.player) {
    const q = bodyPts(k), e = q[N - 1], tl = q[N - 3];
    g.fillStyle = 'rgba(0,12,22,.35)'; bodyPath(q, S * 0.022, S * 0.032); g.fill();
    const flick = Math.sin(t * 5 - N * 0.55);
    [-1, -0.45, 0.45, 1].forEach((kk) => {
      const cx = e.x + e.tx * S * 0.035 + e.nx * kk * S * 0.02, cy = e.y + e.ty * S * 0.035 + e.ny * kk * S * 0.02;
      const tx = e.x + e.tx * S * 0.085 + e.nx * (kk * S * 0.045 + flick * S * 0.015), ty = e.y + e.ty * S * 0.085 + e.ny * (kk * S * 0.045 + flick * S * 0.015);
      g.fillStyle = look.tail; g.beginPath(); g.moveTo(tl.x, tl.y);
      g.quadraticCurveTo(cx, cy, tx, ty); g.quadraticCurveTo(cx + e.nx * S * 0.01, cy + e.ny * S * 0.01, tl.x, tl.y); g.fill();
    });
    const f = q[3], fw = widthAt(3);
    [-1, 1].forEach((s) => {
      const bx = f.x + f.nx * s * fw, by = f.y + f.ny * s * fw, fl = 1 + 0.25 * Math.sin(t * 3 + s);
      const tx = bx + f.nx * s * S * 0.04 * fl + f.tx * S * 0.04, ty = by + f.ny * s * S * 0.04 * fl + f.ty * S * 0.04;
      g.fillStyle = look.fin; g.beginPath(); g.moveTo(bx, by);
      g.quadraticCurveTo(bx + f.nx * s * S * 0.035, by + f.ny * s * S * 0.035, tx, ty);
      g.quadraticCurveTo(bx + f.tx * S * 0.012, by + f.ty * S * 0.012, bx, by); g.fill();
    });
    g.save(); bodyPath(q); g.fillStyle = look.base; g.fill(); g.clip();
    look.spots.forEach(([i, r, c], si) => {
      const off = widthAt(i) * (si % 2 ? 0.25 : -0.25);
      g.fillStyle = c; g.beginPath();
      g.ellipse(q[i].x + q[i].nx * off, q[i].y + q[i].ny * off, widthAt(i) * r * 1.1, widthAt(i) * r * 1.45, Math.atan2(q[i].ty, q[i].tx), 0, TAU); g.fill();
    });
    g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = S * 0.012; g.lineCap = 'round'; g.beginPath();
    for (let i = 1; i < N - 2; i++) g.lineTo(q[i].x - q[i].nx * widthAt(i) * 0.35, q[i].y - q[i].ny * widthAt(i) * 0.35);
    g.stroke(); g.restore();
    const h = q[0]; g.fillStyle = '#1b0f0a';
    [-1, 1].forEach((s) => { g.beginPath(); g.arc(h.x + h.nx * s * widthAt(0) * 0.8 - h.tx * S * 0.004, h.y + h.ny * s * widthAt(0) * 0.8 - h.ty * S * 0.004, S * 0.0045, 0, TAU); g.fill(); });
  }

  // ---- update
  // Time-based smoothing: tiny tracker jitter is filtered out, a real arm
  // movement (big distance) passes almost straight through.
  function feed(nx, ny, dt) {
    const tx = nx * W, ty = ny * H;
    if (t - hand.seen > 1.5) { hand.x = tx; hand.y = ty; }
    else {
      const a = 1 - Math.exp(-(6 + 80 * (Math.hypot(tx - hand.x, ty - hand.y) / S)) * dt);
      hand.x += (tx - hand.x) * a; hand.y += (ty - hand.y) * a;
    }
    hand.seen = t;
  }

  // One koi swims toward (tx, ty): a spring pull, water drag and a speed cap,
  // then the body segments follow the head. Returns the speed.
  function swim(k, tx, ty, spring, damp, maxSpeed, dt) {
    const h = k.p[0];
    k.vx += (tx - h.x) * spring * dt; k.vy += (ty - h.y) * spring * dt;
    const d = Math.exp(-damp * dt); k.vx *= d; k.vy *= d;
    let sp = Math.hypot(k.vx, k.vy); const mx = S * maxSpeed;
    if (sp > mx) { k.vx *= mx / sp; k.vy *= mx / sp; sp = mx; }
    h.x += k.vx * dt; h.y += k.vy * dt; k.sp = sp;
    for (let i = 1; i < N; i++) {
      const a = k.p[i - 1], b = k.p[i]; const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey) || 1;
      b.x = a.x + (ex / l) * SEG; b.y = a.y + (ey / l) * SEG;
    }
    return sp;
  }

  // The rival (Active mode only) is slower than the patient. It waits a few
  // seconds at the start, never snatches a bud the patient is about to reach,
  // and sulks for a while after each steal. Nothing is ever taken away.
  function updateRival(dt) {
    if (!M.rival) { rv.on = false; return; }
    if (!rv.on) { rv.on = true; rv.delay = 6; rv.cool = 0; }
    rv.delay -= dt; rv.cool -= dt; rv.rt -= dt;
    const rh = rival.p[0], ph = koi.p[0];
    const open = buds.filter((b) => b.st === 0 && Math.hypot(ph.x - b.x, ph.y - b.y) > S * 0.15);
    let tx, ty;
    if (rv.delay > 0 || rv.cool > 0 || blooms < 2 || !open.length) {
      tx = W * (0.5 + 0.38 * Math.cos(t * 0.3 + 1)); ty = H * (0.5 + 0.34 * Math.sin(t * 0.37 + 2));
    } else {
      let best = open[0];
      open.forEach((b) => { if (Math.hypot(b.x - rh.x, b.y - rh.y) < Math.hypot(best.x - rh.x, best.y - rh.y)) best = b; });
      tx = best.x; ty = best.y;
      if (Math.hypot(rh.x - best.x, rh.y - best.y) < S * 0.07) {
        best.st = 3; rv.stolen++; rv.cool = 6;
        burst(best.x, best.y, 12, { burst: ['150,190,255', '220,235,255'] });
        ripples.push({ x: best.x, y: best.y, r: S * 0.02, a: 0.5 });
        fill();
      }
    }
    swim(rival, tx, ty, 2.4, 3, 0.55, dt);
    if (rival.sp > S * 0.08 && rv.rt <= 0) { ripples.push({ x: rh.x, y: rh.y, r: S * 0.02, a: 0.25 }); rv.rt = 0.2; }
  }

  function update(dt) {
    const hi = getHand ? getHand() : null;
    if (hi) { feed(hi.x, hi.y, dt); hand.px = hi.px; hand.py = hi.py; } else { hand.px = null; hand.py = null; }
    let tx = hand.x, ty = hand.y;
    if (t - hand.seen > 6) { tx = W / 2 + Math.cos(t * 0.5) * S * 0.25; ty = H / 2 + Math.sin(t * 0.7) * S * 0.18; } // no hand: drift calmly
    const h = koi.p[0];
    const sp = swim(koi, tx, ty, M.k, M.damp, M.max, dt);
    rippleT -= dt;
    if (sp > S * 0.08 && rippleT <= 0) { ripples.push({ x: h.x, y: h.y, r: S * 0.02, a: 0.35 }); rippleT = 0.14; }
    updateRival(dt);
    buds.forEach((b) => {
      b.t += dt;
      if (b.st === 0) {
        b.open = 0.1 + 0.04 * Math.sin(b.t * 3);
        if (M.expire && b.kind === 'gold' && b.t > 12) { // Active mode: a gold flower closes if left too long (no penalty)
          b.st = 2; ripples.push({ x: b.x, y: b.y, r: S * 0.02, a: 0.4 }); fill(); return;
        }
        if (Math.hypot(h.x - b.x, h.y - b.y) < S * M.catch) {
          b.st = 1; b.t = 0;
          combo = t - lastBloom < 5 ? combo + 1 : 1; maxCombo = Math.max(maxCombo, combo); lastBloom = t;
          blooms++; points += KINDS[b.kind].pts; light = Math.min(1, light + 0.3);
          burst(b.x, b.y, M.sparks, PALETTES[b.kind]);
          ripples.push({ x: b.x, y: b.y, r: S * 0.03, a: 0.6 }, { x: b.x, y: b.y, r: S * 0.01, a: 0.5 });
          chime((M.combo ? combo - 1 : blooms) + (b.kind === 'gold' ? 3 : b.kind === 'lilac' ? 1 : 0)); hintA = 0; fill();
          if (onBloom) onBloom(blooms);
        }
      } else if (b.st === 1) {
        const k = Math.min(b.t / 0.9, 1); b.open = 1 - Math.pow(1 - k, 3);
        if (k >= 1) { b.st = 2; b.t = 0; garden.push(b); }
      }
    });
    for (let i = buds.length - 1; i >= 0; i--) if (buds[i].st >= 2) buds.splice(i, 1);
    while (garden.length > 14) garden.shift();
    garden.forEach((b) => { b.t += dt; });
    light = Math.max(0, light - dt * 0.04);
    ripples.forEach((r) => { r.r += S * 0.12 * dt; r.a -= dt * 0.22; });
    for (let i = ripples.length - 1; i >= 0; i--) if (ripples[i].a <= 0) ripples.splice(i, 1);
    parts.forEach((p) => { p.l += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; });
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].l > parts[i].m) parts.splice(i, 1);
    if (t - lastBloom > 5) combo = 0;
  }

  // ---- render
  function render() {
    const bg = g.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    bg.addColorStop(0, '#0f6070'); bg.addColorStop(0.55, '#0a3f52'); bg.addColorStop(1, '#051a28');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) glow(W * (0.5 + 0.45 * Math.sin(t * 0.07 * (i + 1) + i * 2)), H * (0.5 + 0.4 * Math.cos(t * 0.05 * (i + 2) + i)), S * 0.45, '110,255,225', 0.045);
    g.globalCompositeOperation = 'source-over';
    pads.forEach((p) => {
      const x = p.x * W, y = p.y * H, r = p.r * S, bob = Math.sin(t * 0.6 + p.n) * S * 0.003;
      g.save(); g.translate(x, y + bob); g.rotate(p.a + Math.sin(t * 0.2 + p.n) * 0.05);
      g.fillStyle = 'rgba(0,10,15,.3)'; g.beginPath(); g.ellipse(r * 0.12, r * 0.2, r, r * 0.92, 0, 0, TAU); g.fill();
      const gr = g.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r); gr.addColorStop(0, '#3fa56a'); gr.addColorStop(1, '#175a3e');
      g.fillStyle = gr; g.strokeStyle = 'rgba(8,50,35,.8)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, 0.3, TAU - 0.05); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(180,240,200,.2)';
      for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(0.5 + i * 0.85) * r * 0.9, Math.sin(0.5 + i * 0.85) * r * 0.9); g.stroke(); }
      g.restore();
    });
    g.lineWidth = 1.5;
    ripples.forEach((r) => {
      g.strokeStyle = `rgba(190,245,255,${Math.max(r.a, 0)})`;
      g.beginPath(); g.arc(r.x, r.y, r.r, 0, TAU); g.stroke();
      g.beginPath(); g.arc(r.x, r.y, r.r * 0.7, 0, TAU); g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1;
    });
    garden.forEach((b, i) => {
      const fade = Math.max(0.25, 1 - b.t / 60);
      g.globalCompositeOperation = 'lighter'; glow(b.x, b.y, S * 0.11, PALETTES[b.kind].glow, 0.16 * fade); g.globalCompositeOperation = 'source-over';
      lotus(b.x, b.y, S * 0.055, 1, fade, b.rot + Math.sin(t * 0.4 + i) * 0.05, PALETTES[b.kind]);
    });
    buds.forEach((b) => {
      const p = 0.5 + 0.5 * Math.sin(b.t * 3), pal = PALETTES[b.kind];
      const fading = M.expire && b.kind === 'gold' && b.t > 8; // a closing gold flower flickers
      g.globalCompositeOperation = 'lighter'; glow(b.x, b.y, S * (0.1 + 0.03 * p), pal.glow, 0.3 + 0.2 * p);
      if (b.st === 0) { g.strokeStyle = `rgba(${pal.ring},${0.25 + 0.25 * p})`; g.lineWidth = 2; g.beginPath(); g.arc(b.x, b.y, S * (0.07 + 0.015 * p), 0, TAU); g.stroke(); }
      g.globalCompositeOperation = 'source-over';
      lotus(b.x, b.y, S * (0.032 + 0.023 * b.open), b.open, fading ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(b.t * 12)) : 1, b.rot, pal);
    });
    if (M.rival) drawKoi(rival, LOOK.rival);
    drawKoi();
    g.globalCompositeOperation = 'lighter';
    flies.forEach((f) => {
      const x = (f.x + Math.sin(t * f.sx + f.ph) * 0.08) * W, y = (f.y + Math.cos(t * f.sy + f.ph * 2) * 0.08) * H;
      const a = (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * f.bl + f.ph))) * (0.35 + 0.65 * light);
      glow(x, y, S * 0.03, '255,233,160', a * 0.6); g.fillStyle = `rgba(255,248,210,${a})`; g.beginPath(); g.arc(x, y, S * 0.0028, 0, TAU); g.fill();
    });
    parts.forEach((p) => { const a = 1 - p.l / p.m; g.fillStyle = `rgba(${p.c},${a})`; g.beginPath(); g.arc(p.x, p.y, p.s * (0.5 + a), 0, TAU); g.fill(); });
    glow(hand.x, hand.y, S * 0.05 * M.ui, '200,255,245', 0.3);
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(220,255,250,.5)'; g.lineWidth = 2; g.beginPath(); g.arc(hand.x, hand.y, S * 0.014 * M.ui, 0, TAU); g.stroke();
    const v = g.createRadialGradient(W / 2, H / 2, S * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, 'rgba(0,8,14,0)'); v.addColorStop(1, 'rgba(0,8,14,.65)');
    g.fillStyle = v; g.fillRect(0, 0, W, H);
    drawPreview();
    hud();
  }

  // Small mirrored camera thumbnail so the patient can see where their hand is.
  function drawPreview() {
    const pc = getPreview ? getPreview() : null;
    if (!pc || !pc.width) return;
    const pw = THUMB.w, ph = (pw * pc.height) / pc.width, px = THUMB.x, py = H - ph - 14;
    g.save(); g.globalAlpha = 0.85; g.beginPath(); g.roundRect(px, py, pw, ph, 12); g.clip();
    g.drawImage(pc, px, py, pw, ph);
    if (hand.px !== null) { g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(px + hand.px * pw, py + hand.py * ph, 6, 0, TAU); g.fill(); }
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.5; g.beginPath(); g.roundRect(px, py, pw, ph, 12); g.stroke();
  }

  function pill(x, y, w, h) { g.fillStyle = 'rgba(255,255,255,.1)'; g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fill(); }
  function hud() {
    const pad = 16;
    g.font = `600 ${S * 0.032 * M.ui}px "Trebuchet MS",system-ui,sans-serif`; g.textBaseline = 'middle';
    pill(pad, pad, S * 0.2 * M.ui, S * 0.07 * M.ui); g.fillStyle = '#ffe3f0'; g.textAlign = 'left';
    g.fillText(`🪷 ${blooms}`, pad + S * 0.025, pad + S * 0.036 * M.ui);
    const px2 = pad + S * 0.2 * M.ui + 10;
    pill(px2, pad, S * 0.2 * M.ui, S * 0.07 * M.ui); g.fillStyle = '#ffe9a8'; g.textAlign = 'left';
    g.fillText(`⭐ ${points}`, px2 + S * 0.025, pad + S * 0.036 * M.ui);
    if (M.rival) {
      const rx = px2 + S * 0.2 * M.ui + 10, rw = S * 0.3;
      pill(rx, pad, rw, S * 0.07); g.fillStyle = '#cfe0ff'; g.fillText(`🐟 Rival ${rv.stolen}`, rx + S * 0.025, pad + S * 0.036);
    }
    if (M.combo && combo > 1) {
      const w = S * 0.18, x = W - pad - w; pill(x, pad, w, S * 0.07); g.fillStyle = '#ffe9a8'; g.textAlign = 'left';
      g.fillText(`Combo ×${combo}`, x + S * 0.02, pad + S * 0.036);
      g.fillStyle = 'rgba(255,233,168,.7)'; g.fillRect(x + S * 0.02, pad + S * 0.062, (w - S * 0.04) * Math.max(0, 1 - (t - lastBloom) / 5), 2);
    }
    if (hintA > 0) {
      g.globalAlpha = hintA; g.fillStyle = '#d8f6f2'; g.textAlign = 'center';
      g.font = `${S * 0.028 * M.ui}px "Trebuchet MS",system-ui,sans-serif`;
      g.fillText('Guide the koi to the glowing buds. Purple is worth 2, gold is worth 3', W / 2, H - 28); g.globalAlpha = 1;
    }
  }

  function frame(now) {
    if (destroyed) return;
    const dt = Math.min((now - last) / 1000, 0.05); last = now; t += dt;
    update(dt); render();
    raf = requestAnimationFrame(frame);
  }
  last = performance.now();
  raf = requestAnimationFrame(frame);

  return {
    setMode(name) { if (MODES[name]) { M = MODES[name]; fill(); } },
    setReach(r) { opts.reach = Math.min(1.6, Math.max(0.6, Number(r) || 1)); },
    unlockAudio,
    /** Start a fresh count (called when the patient presses Start). */
    reset() {
      blooms = 0; points = 0; combo = 0; maxCombo = 0; lastBloom = -99; light = 0; hintA = 1;
      rv.stolen = 0; rv.delay = 6; rv.cool = 0;
      buds.length = 0; garden.length = 0; fill();
    },
    isTracking() { return t - hand.seen < 1; },
    stats() { return { blooms, points, maxCombo, stolen: rv.stolen }; },
    destroy() { destroyed = true; cancelAnimationFrame(raf); try { ac && ac.close(); } catch { /* ignore */ } },
  };
}
