/*
 * avatarDemo.js
 * -------------
 * Looping reference animation for the exercise demo card -- the
 * browser replacement for armup_app.py's draw_pose_hint() /
 * draw_neck_hint(). Renders a small illustrated mascot swinging
 * through rest -> peak -> rest so someone who's never done the
 * exercise has something to copy instead of guessing from a name.
 *
 * Pure function of time: pose = f(exerciseKey, t), no stored state.
 * drawExerciseHint(), fitScale(), poseAt() and RIG_BOUNDS are the
 * same exports as before -- callers don't need to change.
 *
 * v2 notes -- replaced a first pass that looked like a noodle with
 * parts floating on it (no real torso shape, overlapping round-capped
 * strokes at the elbow). Fixed with a filled trapezoid torso and
 * single continuous-path limbs. Still true:
 *   - `elapsedMs` MUST come from the caller's rAF clock, never
 *     Date.now().
 *   - The title/label lives in HTML above the canvas, never drawn
 *     onto it.
 *   - The origin the caller draws at is derived from RIG_BOUNDS (see
 *     fitScale() + pose-test.html), not a hand-picked offset.
 *
 * v3 notes -- two more real bugs, both from actual exercise mechanics
 * being wrong, not just rendering:
 *   1. neck_tilt swung the ENTIRE neck from the shoulder, one degree
 *      value (6 -> 30) always toward the same side. That reads as the
 *      neck stretching and bending toward one shoulder, not a side-
 *      to-side tilt. Fixed by giving the neck a short fixed vertical
 *      segment (shoulder -> neckTop) and only tilting the head at
 *      that pivot, alternating between the left AND right side each
 *      cycle (a sine wave centered on 0, not a one-directional ramp).
 *   2. A shoulder press is a two-arm movement -- both arms press
 *      overhead together -- but only the right arm was animated; the
 *      left just hung at rest the whole time. Fixed by mirroring the
 *      same lift angle onto both shoulders (workArm + workArmL).
 *
 * v4 notes -- press was still wrong even after v3's two-arm fix: it
 * animated a fully straight arm swinging up from the side, but a real
 * shoulder press starts with the elbow already bent (upper arm flared
 * out, forearm up near the shoulder) and extends the elbow to drive
 * the hand overhead. Rebuilt press on the same bent-arm rig curl
 * already uses (see PRESS_* constants), on both arms, mirrored off
 * each other's raw offsets rather than a second angle formula.
 */

// ---------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------
const TAU = Math.PI * 2;
const d2r = (deg) => (deg * Math.PI) / 180;

function polar(origin, angleDeg, length) {
  const r = d2r(angleDeg);
  return { x: origin.x + Math.cos(r) * length, y: origin.y + Math.sin(r) * length };
}

/** Smooth 0 -> 1 -> 0 easing (eases in/out at both ends, so the swing
 *  has real "hang" at rest and peak instead of snapping like a linear
 *  ramp would). */
function wave(phase01) {
  return (1 - Math.cos(phase01 * TAU)) / 2;
}

// ---------------------------------------------------------------
// Palette -- on-brand with the rest of the page (teal body, pink
// clothing) rather than a naturalistic skin tone, so this reads as a
// friendly mascot, not an attempt at a specific person.
// ---------------------------------------------------------------
const PALETTE = {
  body: '#3FE0D0', bodyDark: '#22A99C', bodyLight: '#A8F5EC',
  shirt: '#FF6B8B', shirtDark: '#D44E6C', shirtLight: '#FFB0C1',
  shoe: '#241832',
  eye: '#1B1035',
  glow: 'rgba(63, 224, 208, 0.30)',
};

const PERIOD_MS = 2200;
const NECK_PERIOD_MS = 2600;
const HEAD_ANGLE = -98; // slightly behind vertical -- keeps overhead swings clear of the head
const HEAD_DIST = 34;
const HEAD_RADIUS = 14;
const NECK_LENGTH = 20;   // fixed vertical segment: shoulder -> neck pivot
const HEAD_TILT_LEN = 18; // neck pivot -> head center, used only for neck_tilt
const NECK_MAX_TILT = 28; // degrees each direction for neck_tilt (side to side)

const SHOULDER_HALF_W = 16;
const HIP_HALF_W = 11;
const ARM_LEN_BENT_UPPER = 30;
const ARM_LEN_BENT_LOWER = 28;
const ARM_LEN_STRAIGHT = 46;
const REST_ARM_LEN = 64;
const LEG_LEN = 34;
const LEG_STANCE_DEG = 9;

// Press-specific elbow range. A press does NOT swing a straight arm
// up from the side -- it starts with the elbow already bent (upper
// arm flared out roughly horizontal, forearm pointing up near the
// shoulder/ear) and finishes by extending the elbow so the forearm
// drives the hand overhead. Both angles move together: the upper arm
// rises a bit too (it's not a pure elbow hinge in real life), but the
// forearm extension is what actually reads as "pressing."
const PRESS_UPPER_ANGLE_START = -8;   // upper arm ~horizontal, out to the side
const PRESS_UPPER_ANGLE_END = -82;    // upper arm rotated up near vertical
const PRESS_ELBOW_ANGLE_START = 68;   // sharply bent (hand near shoulder)
const PRESS_ELBOW_ANGLE_END = 168;    // nearly straight overhead (slight natural bend kept)

// Bounding box the character needs at scale=1, used by fitScale().
// left/right/top widened for the new bent-arm press: the elbow flares
// out further than the old straight-arm version did at the bottom of
// the motion, and the extended forearm reaches higher at the top --
// both were computed against the actual angle ranges above, with a
// few units of margin, rather than guessed.
const RIG_BOUNDS = { top: -138, bottom: 50, left: -46, right: 46 };

function rigPhase(elapsedMs, period) {
  return (((elapsedMs % period) + period) % period) / period; // 0..1, never negative
}

/** Returns the full character pose for the given exercise at time
 *  elapsedMs. Pure function -- same input, same output. */
function poseAt(exerciseKey, elapsedMs) {
  const shoulderC = { x: 0, y: -70 };
  const hipC = { x: 0, y: 0 };
  const shoulderL = { x: -SHOULDER_HALF_W, y: shoulderC.y };
  const shoulderR = { x: SHOULDER_HALF_W, y: shoulderC.y };
  const hipL = { x: -HIP_HALF_W, y: 0 };
  const hipR = { x: HIP_HALF_W, y: 0 };
  const head = polar(shoulderC, HEAD_ANGLE, HEAD_DIST);

  // Idle motion -- independent of the exercise wave, slow and subtle,
  // so the character reads as alive without competing with the arm
  // motion (which is the thing actually being taught).
  const legSway = Math.sin(elapsedMs / 1400) * 2.5;
  const footL = polar(hipL, 90 + LEG_STANCE_DEG + legSway, LEG_LEN);
  const footR = polar(hipR, 90 - LEG_STANCE_DEG - legSway, LEG_LEN);
  const armSway = Math.sin(elapsedMs / 1700 + 1) * 3;

  const base = {
    shoulderC, hipC, shoulderL, shoulderR, hipL, hipR, head, headRadius: HEAD_RADIUS,
    footL, footR, tiltDeg: 0,
  };

  if (exerciseKey === 'curl') {
    const w = wave(rigPhase(elapsedMs, PERIOD_MS));
    const elbowAngle = 160 - w * (160 - 45); // 160 (extended) -> 45 (curled)
    const elbow = polar(shoulderR, 90, ARM_LEN_BENT_UPPER);
    const theta = 180 - elbowAngle;
    const wrist = polar(elbow, 90 - theta, ARM_LEN_BENT_LOWER);
    const restWrist = polar(shoulderL, 90 + armSway, REST_ARM_LEN);
    return { ...base, workArm: { type: 'bent', shoulder: shoulderR, elbow, wrist }, restWrist };
  }

  if (exerciseKey === 'raise') {
    const w = wave(rigPhase(elapsedMs, PERIOD_MS));
    const a = 20 + w * (85 - 20); // 20 (arm down) -> 85 (arm at shoulder height)
    const wrist = polar(shoulderR, 90 - a, ARM_LEN_STRAIGHT);
    const restWrist = polar(shoulderL, 90 + armSway, REST_ARM_LEN);
    return { ...base, workArm: { type: 'straight', shoulder: shoulderR, wrist }, restWrist };
  }

  if (exerciseKey === 'press') {
    // Bilateral, bent-arm: both elbows start bent (hands near the
    // shoulders) and extend upward together, rather than a straight
    // arm swinging up from the side. Compute the right arm's
    // elbow/wrist directly from the angle constants, then build the
    // left arm as an exact mirror of the right arm's SHOULDER-RELATIVE
    // offsets (not a separately-derived angle formula) -- that
    // guarantees the two arms are true reflections of each other with
    // no risk of the mirroring math drifting out of sync.
    const w = wave(rigPhase(elapsedMs, PERIOD_MS));
    const upperAngle = PRESS_UPPER_ANGLE_START + w * (PRESS_UPPER_ANGLE_END - PRESS_UPPER_ANGLE_START);
    const elbowAngle = PRESS_ELBOW_ANGLE_START + w * (PRESS_ELBOW_ANGLE_END - PRESS_ELBOW_ANGLE_START);
    const theta = 180 - elbowAngle;
    const elbowR = polar(shoulderR, upperAngle, ARM_LEN_BENT_UPPER);
    const wristR = polar(elbowR, upperAngle - theta, ARM_LEN_BENT_LOWER);

    const mirror = (p, shoulder) => ({ x: shoulder.x - (p.x - shoulderR.x), y: shoulder.y + (p.y - shoulderR.y) });
    const elbowL = mirror(elbowR, shoulderL);
    const wristL = mirror(wristR, shoulderL);

    return {
      ...base,
      workArm: { type: 'bent', shoulder: shoulderR, elbow: elbowR, wrist: wristR },
      workArmL: { type: 'bent', shoulder: shoulderL, elbow: elbowL, wrist: wristL },
    };
  }

  if (exerciseKey === 'neck_tilt') {
    // Side-to-side: `a` is a sine wave centered on 0, so it alternates
    // between +NECK_MAX_TILT (toward the right shoulder) and
    // -NECK_MAX_TILT (toward the left shoulder) every cycle, easing
    // through zero in the middle. The neck itself stays a short fixed
    // vertical segment (shoulderC -> neckTop); only the head pivots at
    // neckTop, so this reads as a head tilting on a neck instead of
    // the whole neck swinging from the shoulder.
    const phase = rigPhase(elapsedMs, NECK_PERIOD_MS);
    const a = NECK_MAX_TILT * Math.sin(TAU * phase);
    const neckTop = polar(shoulderC, -90, NECK_LENGTH);
    const tiltHead = polar(neckTop, -90 + a, HEAD_TILT_LEN);
    const vertRef = polar(neckTop, -90, 40);
    const restWristL = polar(shoulderL, 90 + armSway, REST_ARM_LEN);
    const restWristR = polar(shoulderR, 90 - armSway, REST_ARM_LEN);
    return {
      ...base, head: tiltHead, neckTop, vertRef, tiltDeg: a,
      workArm: { type: 'none' }, restWrist: restWristL, restWristR,
    };
  }

  const restWrist = polar(shoulderL, 90 + armSway, REST_ARM_LEN);
  return { ...base, workArm: { type: 'none' }, restWrist };
}

/** Scale that fits RIG_BOUNDS inside a canvas of size w x h, with margin. */
export function fitScale(w, h, marginPx = 12) {
  const usableW = w - marginPx * 2;
  const usableH = h - marginPx * 2;
  const rigW = RIG_BOUNDS.right - RIG_BOUNDS.left;
  const rigH = RIG_BOUNDS.bottom - RIG_BOUNDS.top;
  return Math.min(usableW / rigW, usableH / rigH);
}

// ---------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------
function S(p, originX, originY, scale) {
  return { x: originX + p.x * scale, y: originY + p.y * scale };
}

/** A filled "tube" following an arbitrary polyline: dark outline +
 *  base color fill + a soft light-from-above gloss stripe, all drawn
 *  as ONE continuous path with round line joins. This is what makes a
 *  bent arm (shoulder -> elbow -> wrist) bend smoothly instead of
 *  showing two overlapping round end-caps at the elbow. */
function capsulePath(ctx, points, width, colorBase, colorDark) {
  const strokeAt = (yOffset, w, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    points.forEach((p, i) => {
      const y = p.y + yOffset;
      if (i === 0) ctx.moveTo(p.x, y); else ctx.lineTo(p.x, y);
    });
    ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokeAt(0, width, colorDark);
  strokeAt(0, width * 0.8, colorBase);
  strokeAt(-width * 0.14, Math.max(1, width * 0.22), 'rgba(255,255,255,0.30)');
  ctx.restore();
}

function drawTorso(ctx, shoulderL, shoulderR, hipR, hipL, scale) {
  ctx.save();
  const grad = ctx.createLinearGradient(0, shoulderL.y, 0, hipL.y);
  grad.addColorStop(0, PALETTE.shirtLight);
  grad.addColorStop(1, PALETTE.shirtDark);

  ctx.beginPath();
  ctx.moveTo(shoulderL.x, shoulderL.y);
  ctx.lineTo(shoulderR.x, shoulderR.y);
  ctx.lineTo(hipR.x, hipR.y);
  ctx.lineTo(hipL.x, hipL.y);
  ctx.closePath();

  ctx.fillStyle = grad;
  ctx.fill();
  // Soften the trapezoid's sharp corners cheaply by stroking the same
  // closed path with a round join, same color as the fill.
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, 9 * scale);
  ctx.strokeStyle = PALETTE.shirt;
  ctx.stroke();

  // Waistband + collar hint -- small clothing details, cheap to add.
  ctx.strokeStyle = PALETTE.shirtDark;
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.beginPath();
  ctx.moveTo(hipL.x, hipL.y);
  ctx.lineTo(hipR.x, hipR.y);
  ctx.stroke();
  ctx.restore();
}

function jointDot(ctx, p, r, colorBase, colorLight) {
  const grad = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
  grad.addColorStop(0, colorLight);
  grad.addColorStop(1, colorBase);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.fill();
}

function drawFace(ctx, center, radius, tiltDeg) {
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(d2r(tiltDeg));

  const grad = ctx.createRadialGradient(-radius * 0.3, -radius * 0.35, radius * 0.2, 0, 0, radius);
  grad.addColorStop(0, PALETTE.bodyLight);
  grad.addColorStop(1, PALETTE.body);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, TAU);
  ctx.fill();

  // Owl-ish ear tufts -- ties to the neck_tilt exercise, reads as
  // friendly personality on the others.
  ctx.fillStyle = PALETTE.shirt;
  ctx.beginPath();
  ctx.moveTo(-radius * 0.55, -radius * 0.72);
  ctx.lineTo(-radius * 0.15, -radius * 1.18);
  ctx.lineTo(-radius * 0.02, -radius * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(radius * 0.55, -radius * 0.72);
  ctx.lineTo(radius * 0.15, -radius * 1.18);
  ctx.lineTo(radius * 0.02, -radius * 0.55);
  ctx.closePath();
  ctx.fill();

  // Cheeks
  ctx.fillStyle = 'rgba(255,107,139,0.38)';
  ctx.beginPath();
  ctx.ellipse(-radius * 0.52, radius * 0.22, radius * 0.17, radius * 0.11, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(radius * 0.52, radius * 0.22, radius * 0.17, radius * 0.11, 0, 0, TAU);
  ctx.fill();

  // Eyes + shine
  ctx.fillStyle = PALETTE.eye;
  ctx.beginPath();
  ctx.ellipse(-radius * 0.32, -radius * 0.04, radius * 0.115, radius * 0.15, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(radius * 0.32, -radius * 0.04, radius * 0.115, radius * 0.15, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(-radius * 0.27, -radius * 0.1, radius * 0.04, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(radius * 0.37, -radius * 0.1, radius * 0.04, 0, TAU);
  ctx.fill();

  // Smile
  ctx.strokeStyle = PALETTE.eye;
  ctx.lineWidth = Math.max(1, radius * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, radius * 0.1, radius * 0.32, d2r(20), d2r(160));
  ctx.stroke();

  ctx.restore();
}

function drawCharacter(ctx, pose, originX, originY, scale) {
  const P = (p) => S(p, originX, originY, scale);
  const shoulderC = P(pose.shoulderC);
  const shoulderL = P(pose.shoulderL);
  const shoulderR = P(pose.shoulderR);
  const hipL = P(pose.hipL);
  const hipR = P(pose.hipR);
  const head = P(pose.head);
  const footL = P(pose.footL);
  const footR = P(pose.footR);

  const armW = Math.max(4, 11.5 * scale);
  const legW = Math.max(4, 11 * scale);

  // Ground shadow
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse((footL.x + footR.x) / 2, Math.max(footL.y, footR.y) + 4 * scale, 24 * scale, 6 * scale, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Legs, from their own hip corners (not a shared center point)
  capsulePath(ctx, [hipL, footL], legW, PALETTE.body, PALETTE.bodyDark);
  capsulePath(ctx, [hipR, footR], legW, PALETTE.body, PALETTE.bodyDark);
  ctx.fillStyle = PALETTE.shoe;
  [footL, footR].forEach((f) => {
    ctx.beginPath();
    ctx.ellipse(f.x, f.y + 2 * scale, 8.5 * scale, 5 * scale, 0, 0, TAU);
    ctx.fill();
  });

  ctx.save();
  ctx.shadowColor = PALETTE.glow;
  ctx.shadowBlur = 10 * scale;

  // Torso -- real shape, not a center-line, so arms visibly attach to
  // a body instead of growing out of empty space.
  drawTorso(ctx, shoulderL, shoulderR, hipR, hipL, scale);

  // Resting arm(s) -- only drawn when that side isn't already doing
  // the exercise. Bilateral moves (the press) set workArmL instead of
  // restWrist, so there's nothing idle left to draw on that side.
  if (pose.restWrist) {
    const restWrist = P(pose.restWrist);
    capsulePath(ctx, [shoulderL, restWrist], armW * 0.92, PALETTE.body, PALETTE.bodyDark);
    jointDot(ctx, restWrist, armW * 0.48, PALETTE.shirtDark, PALETTE.shirtLight);
  }
  if (pose.restWristR) {
    const restWristR = P(pose.restWristR);
    capsulePath(ctx, [shoulderR, restWristR], armW * 0.92, PALETTE.body, PALETTE.bodyDark);
    jointDot(ctx, restWristR, armW * 0.48, PALETTE.shirtDark, PALETTE.shirtLight);
  }

  // Working arm(s) -- ONE continuous path per arm (shoulder -> elbow
  // -> wrist for a bent arm), so a bent elbow bends smoothly instead
  // of stacking two round end-caps into a blob. Exercises done with
  // both arms (currently just the press) set both workArm and
  // workArmL; single-arm exercises only set workArm.
  const drawWorkArm = (armDef) => {
    if (!armDef || armDef.type === 'none') return;
    const shoulder = P(armDef.shoulder);
    const wrist = P(armDef.wrist);
    if (armDef.type === 'bent') {
      const elbow = P(armDef.elbow);
      capsulePath(ctx, [shoulder, elbow, wrist], armW, PALETTE.body, PALETTE.bodyDark);
    } else if (armDef.type === 'straight') {
      capsulePath(ctx, [shoulder, wrist], armW, PALETTE.body, PALETTE.bodyDark);
    }
    jointDot(ctx, wrist, armW * 0.52, PALETTE.shirtDark, PALETTE.shirtLight);
  };
  drawWorkArm(pose.workArm);
  drawWorkArm(pose.workArmL);

  ctx.restore();

  // Neck-tilt vertical reference (dashed, faint) -- anchored at
  // neckTop when present, so it lines up with the pivot the head
  // actually tilts around.
  if (pose.vertRef) {
    const vertRef = P(pose.vertRef);
    const refOrigin = pose.neckTop ? P(pose.neckTop) : shoulderC;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#9AA8C4';
    ctx.lineWidth = Math.max(1, 1.5 * scale);
    ctx.setLineDash([3 * scale, 4 * scale]);
    ctx.beginPath();
    ctx.moveTo(refOrigin.x, refOrigin.y);
    ctx.lineTo(vertRef.x, vertRef.y);
    ctx.stroke();
    ctx.restore();
  }

  // Neck + head (drawn last, on top of everything). For neck_tilt,
  // pose.neckTop is a fixed point just above the shoulders -- the
  // neck bends there, not at the shoulder itself, so tilting reads as
  // the head leaning on a short neck instead of the whole neck
  // swinging like a pendulum from the shoulder (see v3 notes above).
  ctx.save();
  ctx.strokeStyle = PALETTE.bodyDark;
  ctx.lineWidth = Math.max(4, 11 * scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(shoulderC.x, shoulderC.y);
  if (pose.neckTop) {
    const neckTop = P(pose.neckTop);
    ctx.lineTo(neckTop.x, neckTop.y);
  }
  ctx.lineTo(head.x, head.y);
  ctx.stroke();
  ctx.restore();

  drawFace(ctx, head, Math.max(6, pose.headRadius * scale), pose.tiltDeg);
}

/** Small fading trail of dots tracing the moving hand (or head, for
 *  neck_tilt) over the last few frames -- a motion cue without
 *  cluttering the scene with duplicate full characters. */
function drawMotionTrail(ctx, exerciseKey, originX, originY, scale, elapsedMs) {
  const offsets = [260, 180, 100];
  const alphas = [0.10, 0.18, 0.28];
  for (let i = 0; i < offsets.length; i++) {
    const p = poseAt(exerciseKey, elapsedMs - offsets[i]);
    const target = exerciseKey === 'neck_tilt' ? p.head : (p.workArm.wrist || p.head);
    const pt = S(target, originX, originY, scale);
    ctx.save();
    ctx.globalAlpha = alphas[i];
    ctx.fillStyle = PALETTE.shirtLight;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, Math.max(3, 7 * scale * (0.6 + i * 0.15)), 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Draws one frame of the looping demo character into ctx, centered at
 * (originX, originY) with the shoulder/hip midline at x=0. `elapsedMs`
 * MUST come from the same rAF-driven clock as the rest of the
 * caller's loop -- never Date.now().
 */
export function drawExerciseHint(ctx, exerciseKey, originX, originY, scale, elapsedMs) {
  drawMotionTrail(ctx, exerciseKey, originX, originY, scale, elapsedMs);
  const pose = poseAt(exerciseKey, elapsedMs);
  drawCharacter(ctx, pose, originX, originY, scale);
}

export { RIG_BOUNDS, poseAt };