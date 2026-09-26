// Standalone test -- no UI, no camera, no framework. Run with:
//   node engine.test.mjs
// Mirrors the `if __name__ == "__main__":` block in armup_engine.py
// scenario-for-scenario, so the printed numbers can be diffed directly
// against the Python output to confirm the JS port behaves identically.

import { SessionState } from './engine.js';

console.log("ArmUp Engine (JS) standalone test\n");

const session = new SessionState({ exerciseKey: "curl" });

// Simulate a fake sequence of angles as if a person did 3 REAL curls.
const fakeAngleSequence = [
  ...Array(4).fill(160), 140, 100, 60, ...Array(5).fill(45), 60, 100, 140, ...Array(4).fill(160), // rep 1
  140, 100, 60, ...Array(5).fill(45), 60, 100, 140, ...Array(4).fill(160),                         // rep 2
  140, 100, 60, ...Array(5).fill(45), 60, 100, 140, ...Array(4).fill(160),                         // rep 3
];
for (const angle of fakeAngleSequence) {
  const feedback = session.update(angle);
  if (feedback.event === "rep_complete") {
    console.log(`Rep ${session.reps} complete! ${feedback.message} (score=${session.score}, streak=${session.streak})`);
  }
}
console.log(`\nFinal: ${session.reps} reps, score ${session.score}, accuracy ${session.accuracy()}%, level ${session.level}`);

console.log("\n--- Jitter-only test (no real movement, should log ZERO reps AND zero attempts) ---");
const still = new SessionState({ exerciseKey: "curl" });
// Simple seeded PRNG so this is reproducible like Python's random.seed(1)
// (not meant to match Python's exact sequence, just to exercise the same
// "noisy but stationary" scenario deterministically).
let seed = 1;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
for (let i = 0; i < 200; i++) {
  const noisyAngle = 160 + (rand() * 16 - 8); // +/- 8 degrees
  still.update(noisyAngle);
}
console.log(`Reps counted from pure jitter: ${still.reps} (should be 0)`);
console.log(`Attempts logged from pure jitter: ${still.hitLog.length} (should be 0)`);

console.log("\n--- Half-curl test (should log 0 reps and 1 PARTIAL, accuracy 0%) ---");
const half = new SessionState({ exerciseKey: "curl" });
const halfCurlSequence = [...Array(4).fill(160), 140, 120, 100, 90, 100, 120, 140, ...Array(4).fill(160)];
for (const angle of halfCurlSequence) {
  const feedback = half.update(angle);
  if (feedback.event === "rep_partial") {
    console.log(`Partial rep: '${feedback.message}'`);
  }
}
console.log(`reps=${half.reps}, hitLog=${JSON.stringify(half.hitLog)}, accuracy=${half.accuracy()}% (should be 0 reps, ["partial"], 0%)`);

console.log("\n--- Mixed test (3 clean curls + 1 half curl -> accuracy should be 75%) ---");
const mixed = new SessionState({ exerciseKey: "curl" });
for (const angle of [...fakeAngleSequence, 140, 120, 100, 90, 100, 120, 140, ...Array(4).fill(160)]) {
  mixed.update(angle);
}
console.log(`reps=${mixed.reps}, hitLog=${JSON.stringify(mixed.hitLog)}, accuracy=${mixed.accuracy()}%, streak after the miss=${mixed.streak} (should be 0)`);

console.log("\n--- Starting tolerance test ---");
const defaultTol = new SessionState({ exerciseKey: "raise" });
const gentleTol = new SessionState({ exerciseKey: "raise", startingTolerance: 20.0 });
console.log(`raise default tolerance: ${defaultTol.tolerance} (should be 15)`);
console.log(`raise with startingTolerance=20: ${gentleTol.tolerance} (should be 20)`);
for (const [s, label] of [[defaultTol, "default"], [gentleTol, "gentle"]]) {
  for (const angle of [...Array(4).fill(20), 40, 55, ...Array(5).fill(67), 55, 40, ...Array(4).fill(20)]) {
    s.update(angle);
  }
  console.log(`  raise reaching only 67 deg with ${label} tolerance -> reps=${s.reps}, hitLog=${JSON.stringify(s.hitLog)}`);
}

console.log("\n--- Neck Tilt test (2 real owl tilts, should log 2 reps) ---");
const neck = new SessionState({ exerciseKey: "neck_tilt" });
const fakeNeckSequence = [
  ...Array(4).fill(6), 14, 22, ...Array(5).fill(30), 22, 14, ...Array(4).fill(6),  // tilt 1
  14, 22, ...Array(5).fill(30), 22, 14, ...Array(4).fill(6),                       // tilt 2
];
for (const angle of fakeNeckSequence) {
  const feedback = neck.update(angle);
  if (feedback.event === "rep_complete") {
    console.log(`Neck tilt ${neck.reps} complete! ${feedback.message}`);
  }
}
console.log(`Neck tilt reps counted: ${neck.reps} (should be 2)`);

console.log("\n--- resetStats test (switch exercise mid-run) ---");
const multi = new SessionState({ exerciseKey: "curl" });
for (const angle of fakeAngleSequence) multi.update(angle);
console.log(`After curls: reps=${multi.reps}, score=${multi.score}`);
multi.setExercise("neck_tilt");
multi.resetStats();
console.log(`After switch+reset: reps=${multi.reps}, score=${multi.score}, exerciseKey=${multi.exerciseKey} (reps/score should be 0, key should be neck_tilt)`);
for (const angle of fakeNeckSequence) multi.update(angle);
console.log(`After neck tilts: reps=${multi.reps} (should be 2, not mixed with curl reps)`);

console.log("\n--- Form feedback test (curl elbow_drift) ---");
const form = new SessionState({ exerciseKey: "curl" });
let msg = null;
for (let i = 0; i < 10; i++) {
  msg = form.checkForm({ elbow_drift: 45 }) || msg;
}
console.log(`Fault message after 10 bad frames: '${msg}' (should be the elbow_drift msg)`);
console.log(`formFaults: ${JSON.stringify(form.formFaults)} (should be {"elbow_drift":1})`);
let msg2 = null;
for (let i = 0; i < 10; i++) {
  msg2 = form.checkForm({ elbow_drift: 10 }) || msg2;
}
console.log(`No new fault while form is good: msg2=${msg2} (should be null), formFaults still ${JSON.stringify(form.formFaults)} (should be unchanged)`);
