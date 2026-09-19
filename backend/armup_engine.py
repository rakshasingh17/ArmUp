"""
ArmUp Engine
------------
This module is the "software" part of ArmUp: it knows nothing about
webcams, OpenCV, or rendering. Given joint coordinates, it computes
angles, tracks rep state (rest -> peak -> rest), scores reps, and
adjusts difficulty. It can be tested entirely from a terminal, with
zero interface attached -- that's the whole point.

Any interface (this Python/OpenCV app, a future Electron+React app,
a future VR app) just needs to feed it landmark coordinates and read
its output.

CHANGE LOG (fix for "score increases with no movement"):
- update() now requires the angle to stay inside a target zone for
  several CONSECUTIVE frames (HOLD_FRAMES_REQUIRED) before the state
  actually transitions. A single noisy frame can no longer trigger a
  rep -- this is the main fix.
- update() now accepts landmarks_visible, so the caller can tell the
  engine "don't trust this frame" (e.g. low MediaPipe visibility score)
  and the engine will simply not advance the hold counters that frame.

CHANGE LOG (new exercise: neck_tilt):
- Added a 4th exercise, "Owl Neck Tilt" -- a cervical (neck)
  side-to-side tilt, common in real physio for neck pain / stiffness
  rehab, distinct from the three arm exercises. It reuses the exact
  same angle_at() + hold-frame + DDA machinery, it just measures a
  different triangle (see armup_app.py for how the vertex points are
  built, since the "neck base" and "vertical reference" points aren't
  raw MediaPipe landmarks -- they're derived in the interface layer).

CHANGE LOG (reset_stats for per-exercise session saving):
- Added reset_stats(), separate from set_exercise(). set_exercise() only
  ever reset the rep-state machine (rep_state/_peak_hold/_rest_hold) --
  it deliberately left reps/score/streak/max_streak/level/hit_log alone,
  since originally one SessionState was meant to persist for a whole
  run regardless of exercise switches. The interface layer (armup_app.py)
  now saves+resets stats on every exercise switch instead, so
  reset_stats() gives it a clean way to zero out just the accumulated
  counters without touching exercise_key or the rep-state machine (that
  still gets reset by set_exercise() as before).
"""

import math
from dataclasses import dataclass, field


# ---------------------------------------------------------------
# Exercise definitions
# ---------------------------------------------------------------
# Each exercise is defined by three landmark names (to measure the
# angle at the middle joint) and the expected "rest" vs "peak" angle.
EXERCISES = {
    "curl": {
        "name": "Bicep Curl",
        "landmarks": ("LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST"),
        "rest": 160, "peak": 45, "tolerance": 15,
        "rest_msg": "Extend fully", "peak_msg": "Nice and curled",
    },
    "raise": {
        "name": "Lateral Raise",
        "landmarks": ("LEFT_HIP", "LEFT_SHOULDER", "LEFT_ELBOW"),
        "rest": 20, "peak": 85, "tolerance": 15,
        "rest_msg": "Lower fully", "peak_msg": "Great height",
    },
    "press": {
        "name": "Shoulder Press",
        "landmarks": ("LEFT_HIP", "LEFT_SHOULDER", "LEFT_WRIST"),
        "rest": 30, "peak": 165, "tolerance": 15,
        "rest_msg": "Reset lower", "peak_msg": "Full extension",
    },
    "neck_tilt": {
        "name": "Owl Neck Tilt",
        # Vertex is "NECK_BASE" (midpoint of the shoulders, built in
        # armup_app.py). One ray points straight up ("VERTICAL_REF"),
        # the other points to the NOSE. Angle between them ~= how far
        # the head is tilted off-vertical, in either direction.
        "landmarks": ("VERTICAL_REF", "NECK_BASE", "NOSE"),
        "rest": 6, "peak": 30, "tolerance": 8,
        "rest_msg": "Head centered", "peak_msg": "Great tilt, owl!",
    },
}

# How many CONSECUTIVE frames the angle must stay inside a target zone
# before the rep state is allowed to transition. At ~20-30fps, 3-4 frames
# is roughly 100-150ms -- long enough to filter single-frame landmark
# jitter, short enough that real movement never feels laggy.
HOLD_FRAMES_REQUIRED = 4

# Minimum visibility (0-1) MediaPipe must report for a landmark before we
# trust it. Below this, we treat the frame as unreliable and skip it
# rather than feeding a guessed position into the angle calculation.
MIN_VISIBILITY = 0.5


def angle_at(a, b, c):
    """
    Returns the angle (in degrees) at point b, formed by points a-b-c.
    a, b, c are (x, y) tuples. Pure geometry, no MediaPipe/OpenCV involved.
    """
    ang = math.degrees(
        math.atan2(c[1] - b[1], c[0] - b[0]) -
        math.atan2(a[1] - b[1], a[0] - b[0])
    )
    ang = abs(ang)
    if ang > 180:
        ang = 360 - ang
    return ang


@dataclass
class SessionState:
    """All the state for one exercise session. Pure data + logic, no UI."""
    exercise_key: str = "curl"
    rep_state: str = "rest"       # "rest" or "peak"
    score: int = 0
    reps: int = 0
    streak: int = 0
    max_streak: int = 0
    level: int = 1
    hit_log: list = field(default_factory=list)  # list of "correct"/"partial"

    # --- debounce counters (not meant to be read from outside) ---
    _peak_hold: int = 0
    _rest_hold: int = 0

    @property
    def exercise(self):
        return EXERCISES[self.exercise_key]

    def set_exercise(self, key):
        if key in EXERCISES:
            self.exercise_key = key
            self.rep_state = "rest"
            self._peak_hold = 0
            self._rest_hold = 0

    def reset_stats(self):
        """Zeroes out the accumulated scoring counters (reps, score,
        streak, max_streak, level, hit_log) without touching exercise_key
        or the rep-state machine. Intended for callers that want to save
        off the current exercise's stats and then start the next exercise
        from a clean slate -- e.g. armup_app.py calls this right after
        save_session_to_backend() + set_exercise() when the person
        switches exercises mid-run, so each exercise gets its own
        independent, correctly-attributed saved session instead of one
        merged blob."""
        self.score = 0
        self.reps = 0
        self.streak = 0
        self.max_streak = 0
        self.level = 1
        self.hit_log = []

    def update(self, live_angle, landmarks_visible=True):
        """
        Feed the current joint angle in. Returns a feedback dict:
        {"event": "rep_complete"/"none", "quality": "correct"/"partial"/None, "message": str}

        landmarks_visible: pass False when the caller isn't confident in
        the tracked points this frame (e.g. low MediaPipe visibility, or
        the person stepped partly out of frame). Unreliable frames are
        simply skipped -- they don't advance or reset the debounce
        counters, so a brief tracking glitch can't fake a rep.
        """
        result = {"event": "none", "quality": None, "message": ""}
        if not landmarks_visible:
            return result

        ex = self.exercise
        rest_angle, peak_angle = ex["rest"], ex["peak"]
        tolerance = self._current_tolerance(ex["tolerance"])

        near_rest = abs(live_angle - rest_angle) <= tolerance
        near_peak = abs(live_angle - peak_angle) <= tolerance

        if self.rep_state == "rest":
            self._peak_hold = self._peak_hold + 1 if near_peak else 0
            if self._peak_hold >= HOLD_FRAMES_REQUIRED:
                self.rep_state = "peak"
                self._peak_hold = 0
                self._rest_hold = 0

        elif self.rep_state == "peak":
            self._rest_hold = self._rest_hold + 1 if near_rest else 0
            if self._rest_hold >= HOLD_FRAMES_REQUIRED:
                # completed a full, held rest -> peak -> rest cycle
                self.rep_state = "rest"
                self._rest_hold = 0
                self._peak_hold = 0
                self.reps += 1
                quality = "correct"
                self.streak += 1
                self.max_streak = max(self.max_streak, self.streak)
                self.score += 10 + self.streak  # streak bonus, like a combo
                self.hit_log.append(quality)
                self._maybe_level_up()
                result = {"event": "rep_complete", "quality": quality,
                          "message": ex["peak_msg"]}

        return result

    def _current_tolerance(self, base_tolerance):
        """Simple DDA: tolerance shrinks slightly as streak grows (harder),
        resets wider if streak breaks. This is the adaptive-difficulty logic."""
        shrink = min(self.streak // 3, 5)  # shrink up to 5 degrees max
        return max(base_tolerance - shrink, 6)

    def _maybe_level_up(self):
        if self.reps % 5 == 0:
            self.level += 1

    def accuracy(self):
        if not self.hit_log:
            return 0
        correct = self.hit_log.count("correct")
        return round(correct / len(self.hit_log) * 100)


# ---------------------------------------------------------------
# Quick standalone test -- run this file directly with no UI at all
# to prove the engine works independently.
# ---------------------------------------------------------------
if __name__ == "__main__":
    print("ArmUp Engine standalone test (no UI, no webcam)\n")

    session = SessionState(exercise_key="curl")

    # Simulate a fake sequence of angles as if a person did 3 REAL curls.
    # Each target zone is repeated several times in a row to satisfy the
    # new hold-frame requirement, mirroring what real continuous motion
    # naturally does (many frames near the top, many near the bottom).
    fake_angle_sequence = (
        [160]*4 + [140, 100, 60] + [45]*5 + [60, 100, 140] + [160]*4 +   # rep 1
        [140, 100, 60] + [45]*5 + [60, 100, 140] + [160]*4 +             # rep 2
        [140, 100, 60] + [45]*5 + [60, 100, 140] + [160]*4               # rep 3
    )
    for angle in fake_angle_sequence:
        feedback = session.update(angle)
        if feedback["event"] == "rep_complete":
            print(f"Rep {session.reps} complete! {feedback['message']} "
                  f"(score={session.score}, streak={session.streak})")

    print(f"\nFinal: {session.reps} reps, score {session.score}, "
          f"accuracy {session.accuracy()}%, level {session.level}")

    print("\n--- Jitter-only test (no real movement, should log ZERO reps) ---")
    still = SessionState(exercise_key="curl")
    import random
    random.seed(1)
    # Person just standing still at ~160 degrees, with +/-8 degree camera jitter
    for _ in range(200):
        noisy_angle = 160 + random.uniform(-8, 8)
        still.update(noisy_angle)
    print(f"Reps counted from pure jitter: {still.reps} (should be 0)")

    print("\n--- Neck Tilt test (2 real owl tilts, should log 2 reps) ---")
    neck = SessionState(exercise_key="neck_tilt")
    fake_neck_sequence = (
        [6]*4 + [14, 22] + [30]*5 + [22, 14] + [6]*4 +   # tilt 1
        [14, 22] + [30]*5 + [22, 14] + [6]*4             # tilt 2
    )
    for angle in fake_neck_sequence:
        feedback = neck.update(angle)
        if feedback["event"] == "rep_complete":
            print(f"Neck tilt {neck.reps} complete! {feedback['message']}")
    print(f"Neck tilt reps counted: {neck.reps} (should be 2)")

    print("\n--- reset_stats test (switch exercise mid-run) ---")
    multi = SessionState(exercise_key="curl")
    for angle in fake_angle_sequence:
        multi.update(angle)
    print(f"After curls: reps={multi.reps}, score={multi.score}")
    multi.set_exercise("neck_tilt")
    multi.reset_stats()
    print(f"After switch+reset: reps={multi.reps}, score={multi.score}, "
          f"exercise_key={multi.exercise_key} (reps/score should be 0, key should be neck_tilt)")
    for angle in fake_neck_sequence:
        multi.update(angle)
    print(f"After neck tilts: reps={multi.reps} (should be 2, not mixed with curl reps)")