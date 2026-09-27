/*
 * ArmUp Engine (JS port)
 * ----------------------
 * Direct port of backend/armup_engine.py. Knows nothing about the
 * webcam, MediaPipe, or canvas rendering -- given joint coordinates
 * (or a precomputed angle), it tracks rep state (rest -> peak -> rest),
 * scores reps, checks form, and adjusts difficulty (DDA).
 *
 * Ported 1:1 from the Python version so behavior matches exactly:
 * same constants, same state machine, same field names (camelCase
 * instead of snake_case, and no leading underscore for "private"
 * fields -- JS has no real private-by-convention equivalent as clean
 * as Python's, so those are just documented as internal-only below).
 *
 * Any caller (GameCanvas.jsx, a future ExerciseCanvas.jsx, a unit
 * test) just needs to feed it landmark coordinates or an angle and
 * read its output -- exactly the same contract as the Python engine
 * had with armup_app.py.
 */

// ---------------------------------------------------------------
// Exercise definitions (identical to EXERCISES in armup_engine.py)
// ---------------------------------------------------------------
export const EXERCISES = {
  curl: {
    name: "Bicep Curl",
    landmarks: ["LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST"],
    rest: 160, peak: 45, tolerance: 15,
    restMsg: "Extend fully", peakMsg: "Nice and curled",
    partialMsg: "Curl a bit higher",
  },
  raise: {
    name: "Lateral Raise",
    landmarks: ["LEFT_HIP", "LEFT_SHOULDER", "LEFT_ELBOW"],
    rest: 20, peak: 85, tolerance: 15,
    restMsg: "Lower fully", peakMsg: "Great height",
    partialMsg: "Raise a little higher",
  },
  press: {
    name: "Shoulder Press",
    // FIX: was ["LEFT_HIP", "LEFT_SHOULDER", "LEFT_WRIST"] with
    // rest: 30 -- that measures the whole arm's angle relative to the
    // torso, treating shoulder->wrist as one straight line. A rest
    // angle of 30 degrees corresponds to the arm hanging almost
    // straight down at the side, which is NOT where a press actually
    // returns to between reps -- a real press racks the weight near
    // the shoulder with the elbow bent (~90-130 degrees on this
    // landmark set), never dropping the arm fully. That meant
    // _restHold could never trigger for someone using correct form,
    // so reps would silently fail to register as complete.
    //
    // Fixed by measuring elbow extension directly instead (same
    // landmark pattern curl already uses: SHOULDER-ELBOW-WRIST), which
    // is what a press actually is -- the elbow straightening to drive
    // the hand overhead -- and doesn't depend on exactly how high the
    // person racks the weight.
    //
    // rest/peak below are a reasonable starting estimate (bent ~90 ->
    // near-locked ~172), NOT physio-validated -- same caveat as
    // FORM_RULES below. Test against real reps and tune before
    // shipping; if reps still won't complete, `rest` is probably too
    // low for how bent people actually rack the weight.
    landmarks: ["LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST"],
    rest: 90, peak: 172, tolerance: 15,
    restMsg: "Reset lower", peakMsg: "Full extension",
    partialMsg: "Push all the way up",
  },
  neck_tilt: {
    name: "Owl Neck Tilt",
    // Vertex is "NECK_BASE" (midpoint of the shoulders, derived by the
    // caller -- see NECK_SYNTHETIC_POINTS note below, same as
    // armup_app.py). One ray points straight up ("VERTICAL_REF"), the
    // other points to NOSE. Angle between them ~= how far the head is
    // tilted off-vertical, in either direction.
    landmarks: ["VERTICAL_REF", "NECK_BASE", "NOSE"],
    rest: 6, peak: 30, tolerance: 8,
    restMsg: "Head centered", peakMsg: "Great tilt, owl!",
    partialMsg: "Tilt a bit further",
  },
};

// ---------------------------------------------------------------
// Form feedback rules (identical to FORM_RULES in armup_engine.py)
// ---------------------------------------------------------------
// A SECOND, independent angle check per exercise -- separate from the
// rest/peak angle that drives rep counting. Flags a compensation
// pattern (bad technique) instead of counting a rep; a rep can
// complete AND have a form fault flagged in the same frame.
//
// NOTE: these thresholds are estimates, not physio-validated values.
// Report/demo them as prototype-level, same caveat as the Python side.
export const FORM_RULES = {
  curl: [
    { id: "elbow_drift", pts: ["LEFT_HIP", "LEFT_SHOULDER", "LEFT_ELBOW"],
      max: 30, msg: "Keep your elbow tucked in" },
  ],
  raise: [
    { id: "too_high", pts: ["LEFT_HIP", "LEFT_SHOULDER", "LEFT_ELBOW"],
      max: 100, msg: "Stop at shoulder height" },
  ],
  press: [
    { id: "lean_back", pts: ["RIGHT_HIP", "LEFT_HIP", "LEFT_SHOULDER"],
      max: 110, msg: "Don't lean back -- press straight up" },
  ],
};

// How many CONSECUTIVE bad frames before a form fault fires. Longer
// than HOLD_FRAMES_REQUIRED on purpose -- form feedback should catch a
// sustained lapse, not flicker on one noisy frame.
export const FORM_HOLD_FRAMES = 8;

// How many CONSECUTIVE frames the angle must stay inside a target zone
// before the rep state is allowed to transition. At ~20-30fps, 3-4
// frames is roughly 100-150ms -- long enough to filter single-frame
// landmark jitter, short enough real movement never feels laggy.
export const HOLD_FRAMES_REQUIRED = 4;

// Minimum visibility (0-1) the pose model must report for a landmark
// before we trust it. Below this, treat the frame as unreliable and
// skip it rather than feeding a guessed position into the engine.
export const MIN_VISIBILITY = 0.5;

// How far toward the peak (0 = rest angle, 1 = peak angle) a movement
// must get, then return to rest without holding the peak zone, to be
// logged as a "partial" rep instead of ignored as a non-attempt.
export const PARTIAL_PROGRESS = 0.5;

/**
 * Returns the angle (in degrees) at point b, formed by points a-b-c.
 * a, b, c are {x, y} (or [x, y]) -- pure geometry, no pose-model
 * dependency, identical math to angle_at() in armup_engine.py.
 */
export function angleAt(a, b, c) {
  const ax = a.x ?? a[0], ay = a.y ?? a[1];
  const bx = b.x ?? b[0], by = b.y ?? b[1];
  const cx = c.x ?? c[0], cy = c.y ?? c[1];

  let ang = (Math.atan2(cy - by, cx - bx) - Math.atan2(ay - by, ax - bx)) * (180 / Math.PI);
  ang = Math.abs(ang);
  if (ang > 180) ang = 360 - ang;
  return ang;
}

/**
 * All the state for one exercise session. Pure data + logic, no UI --
 * a direct port of the SessionState dataclass. Construct with
 * `new SessionState({ exerciseKey: "curl" })`, same optional fields as
 * the Python constructor.
 */
export class SessionState {
  constructor({ exerciseKey = "curl", startingTolerance = null } = {}) {
    this.exerciseKey = exerciseKey;
    this.repState = "rest";       // "rest" or "peak"
    this.score = 0;
    this.reps = 0;                // CORRECT reps only
    this.streak = 0;
    this.maxStreak = 0;
    this.level = 1;
    this.hitLog = [];             // one entry per attempt: "correct" / "partial"

    // Per-user starting tolerance (degrees). null -> use the
    // exercise's default tolerance from EXERCISES.
    this.startingTolerance = startingTolerance;

    // Form-fault counts for the CURRENT exercise: { ruleId: timesFired }
    this.formFaults = {};

    // --- debounce / attempt counters (internal use only -- these are
    // the JS equivalent of Python's leading-underscore "private" fields;
    // nothing outside this class should read or set them directly) ---
    this._peakHold = 0;
    this._restHold = 0;
    this._returnHold = 0;          // consecutive frames back at rest (rest state)
    this._attemptProgress = 0.0;   // furthest 0..1 progress toward peak this attempt
    this._armed = false;           // true once held at rest at least once
    this._formBad = {};            // { ruleId: consecutive bad frames }
  }

  get exercise() {
    return EXERCISES[this.exerciseKey];
  }

  /**
   * The tolerance (degrees) currently in effect, after the user's
   * starting tolerance and the streak-based adaptive shrink.
   */
  get tolerance() {
    return this._currentTolerance(this.exercise.tolerance);
  }

  /**
   * Switch exercise and reset the rep-state machine. Pass the user's
   * startingTolerance for the NEW exercise if they have one; omit
   * (or pass null) to mean "use the exercise's default".
   */
  setExercise(key, startingTolerance = null) {
    if (EXERCISES[key]) {
      this.exerciseKey = key;
      this.startingTolerance = startingTolerance;
      this.repState = "rest";
      this._peakHold = 0;
      this._restHold = 0;
      this._returnHold = 0;
      this._attemptProgress = 0.0;
      this._armed = false;
      this._formBad = {};
    }
  }

  /**
   * Zeroes out the accumulated scoring counters (reps, score, streak,
   * maxStreak, level, hitLog, formFaults) without touching exerciseKey
   * or the rep-state machine. Intended for callers that want to save
   * off the current exercise's stats and then start the next exercise
   * from a clean slate -- e.g. call this right after posting the
   * session to the backend + setExercise() when the person switches
   * exercises mid-run, same pattern as armup_app.py.
   */
  resetStats() {
    this.score = 0;
    this.reps = 0;
    this.streak = 0;
    this.maxStreak = 0;
    this.level = 1;
    this.hitLog = [];
    this.formFaults = {};
  }

  /**
   * Checks the current exercise's FORM_RULES against a dict of
   * pre-computed angles ({ ruleId: degrees }, built by the caller from
   * each rule's three points via angleAt()). Independent of rep
   * counting -- a rep can complete AND have a form fault flagged in
   * the same frame; this never affects reps/score.
   *
   * Returns a correction message (string) the instant a fault crosses
   * FORM_HOLD_FRAMES consecutive bad frames, else null. Fires ONCE per
   * lapse (uses ===, not >=) instead of nagging every frame the person
   * stays in bad form -- identical behavior to the Python version.
   */
  checkForm(angles) {
    const rules = FORM_RULES[this.exerciseKey] || [];
    for (const rule of rules) {
      const angle = angles[rule.id];
      if (angle === undefined || angle === null) continue;
      const bad = angle > rule.max;
      const n = bad ? (this._formBad[rule.id] || 0) + 1 : 0;
      this._formBad[rule.id] = n;
      if (n === FORM_HOLD_FRAMES) {
        this.formFaults[rule.id] = (this.formFaults[rule.id] || 0) + 1;
        return rule.msg;
      }
    }
    return null;
  }

  /** 0 at the rest angle, 1 at the peak angle (can go outside 0..1). */
  _progress(liveAngle) {
    const ex = this.exercise;
    const span = ex.peak - ex.rest;
    return span ? (liveAngle - ex.rest) / span : 0.0;
  }

  /**
   * Feed the current joint angle in. Returns a feedback object:
   * { event: "rep_complete" | "rep_partial" | "none",
   *   quality: "correct" | "partial" | null, message: string }
   *
   * landmarksVisible: pass false when the caller isn't confident in
   * the tracked points this frame (e.g. low pose-model visibility, or
   * the person stepped partly out of frame). Unreliable frames are
   * simply skipped -- they don't advance or reset the debounce
   * counters, so a brief tracking glitch can't fake a rep.
   */
  update(liveAngle, landmarksVisible = true) {
    let result = { event: "none", quality: null, message: "" };
    if (!landmarksVisible) return result;

    const ex = this.exercise;
    const restAngle = ex.rest, peakAngle = ex.peak;
    const tolerance = this._currentTolerance(ex.tolerance);

    const nearRest = Math.abs(liveAngle - restAngle) <= tolerance;
    const nearPeak = Math.abs(liveAngle - peakAngle) <= tolerance;

    if (this.repState === "rest") {
      this._peakHold = nearPeak ? this._peakHold + 1 : 0;
      if (this._peakHold >= HOLD_FRAMES_REQUIRED) {
        // reached and held the target zone -> heading for a full rep
        this.repState = "peak";
        this._peakHold = 0;
        this._restHold = 0;
        this._returnHold = 0;
        this._attemptProgress = 0.0;
      } else if (nearRest) {
        this._returnHold += 1;
        if (this._returnHold >= HOLD_FRAMES_REQUIRED) {
          // Settled back at rest. If they got far enough toward the
          // peak on the way, that was a real attempt that fell short
          // -> partial rep.
          if (this._armed && this._attemptProgress >= PARTIAL_PROGRESS) {
            result = this._registerPartial(ex);
          }
          this._attemptProgress = 0.0;
          this._returnHold = 0;
          this._armed = true;
        }
      } else {
        // Somewhere between rest and peak: remember how far they got.
        this._returnHold = 0;
        if (this._armed) {
          this._attemptProgress = Math.max(
            this._attemptProgress, this._progress(liveAngle)
          );
        }
      }
    } else if (this.repState === "peak") {
      this._restHold = nearRest ? this._restHold + 1 : 0;
      if (this._restHold >= HOLD_FRAMES_REQUIRED) {
        // completed a full, held rest -> peak -> rest cycle
        this.repState = "rest";
        this._restHold = 0;
        this._peakHold = 0;
        this._returnHold = 0;
        this._attemptProgress = 0.0;
        this._armed = true;
        this.reps += 1;
        const quality = "correct";
        this.streak += 1;
        this.maxStreak = Math.max(this.maxStreak, this.streak);
        this.score += 10 + this.streak; // streak bonus, like a combo
        this.hitLog.push(quality);
        this._maybeLevelUp();
        result = { event: "rep_complete", quality, message: ex.peakMsg };
      }
    }

    return result;
  }

  /** An attempt that fell short: no points, no rep, streak resets. */
  _registerPartial(ex) {
    this.streak = 0;
    this.hitLog.push("partial");
    return {
      event: "rep_partial", quality: "partial",
      message: ex.partialMsg ?? "A little further",
    };
  }

  /**
   * Simple DDA: tolerance shrinks slightly as streak grows (harder),
   * and widens back out when the streak breaks (a partial rep). Base
   * is the user's startingTolerance if set (wider = gentler start),
   * otherwise the exercise's default.
   */
  _currentTolerance(baseTolerance) {
    if (this.startingTolerance !== null && this.startingTolerance !== undefined) {
      baseTolerance = this.startingTolerance;
    }
    const shrink = Math.min(Math.floor(this.streak / 3), 5); // shrink up to 5 degrees max
    return Math.max(baseTolerance - shrink, 6);
  }

  _maybeLevelUp() {
    if (this.reps % 5 === 0 && this.reps > 0) this.level += 1;
  }

  /** Percent of attempts that were clean: correct / (correct + partial). */
  accuracy() {
    if (this.hitLog.length === 0) return 0;
    const correct = this.hitLog.filter((h) => h === "correct").length;
    return Math.round((correct / this.hitLog.length) * 100);
  }
}