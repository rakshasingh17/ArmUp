"""
ArmUp App (Interface layer)
----------------------------
This file is ONLY responsible for: webcam capture, pose landmark
extraction, drawing, and reading keyboard input. All scoring/rep/
difficulty logic lives in armup_engine.py and is called from here --
this file never decides what counts as a rep, it just asks the engine.

Controls:
  1 / 2 / 3 / 4  -> switch exercise (Curl / Lateral Raise / Shoulder Press / Neck Tilt)
  SPACE          -> start session (from launch screen)
  q              -> quit

CHANGE LOG (fix for "score increases with no movement"):
- Each landmark's smoothed point is now computed exactly ONCE per frame
  and cached in `frame_points`, then reused both for drawing and for the
  engine feed. Previously get_point() was called a second time for the
  same landmarks right before session.update(), which silently ran the
  smoothing filter twice on one raw sample and slightly distorted it.
- We now also read each landmark's `visibility` score from MediaPipe and
  only feed the engine an angle when all three relevant joints are
  confidently tracked (visibility > MIN_VISIBILITY). Low-confidence /
  guessed landmark positions no longer reach the scoring logic.

CHANGE LOG (new exercise: neck_tilt, key "4"):
- Added NOSE to the tracked landmark set.
- Each frame, we also derive two SYNTHETIC points that aren't raw
  MediaPipe landmarks: NECK_BASE (midpoint of the two shoulders) and
  VERTICAL_REF (a point straight above NECK_BASE). Together with NOSE
  these three points let the engine measure how far the head is tilted
  off-vertical, using the exact same angle_at() + hold-frame + DDA
  machinery as the arm exercises -- no engine changes needed.
- Added a dedicated "owl" demo animation (head tilting side to side)
  for the exercise hint card, since the arm-swing animation doesn't
  make sense for a neck movement.

CHANGE LOG (backend integration):
- Added a user id prompt at startup (from POST /users, defaults to 1)
  and save_session_to_backend(), which POSTs the completed session to
  the FastAPI backend (armup_api.py) when the app quits. This is a
  best-effort call -- if the backend isn't running, the app prints a
  message and continues normally rather than crashing. No engine or
  rendering logic was touched to add this.

CHANGE LOG (dashboard launch support):
- Added --user / --exercise CLI args so the dashboard's "Start Exercise"
  button can launch this script non-interactively (via the API's
  /start-session endpoint) without it blocking on a terminal input()
  prompt. Manual double-click / terminal launches still work exactly as
  before -- if no --user is passed, it falls back to the same input()
  prompt as always.

CHANGE LOG (per-exercise session saving):
- Previously, switching exercises mid-run (pressing 1/2/3/4) kept
  accumulating reps/score/streak into the SAME SessionState, and only
  ONE save happened at quit -- for whatever exercise was active at that
  moment. Everything done on other exercises during that run was silently
  lost. Now, switching exercises triggers a save of the just-finished
  exercise's stats (if it logged any reps) via save_session_to_backend(),
  then calls the engine's new session.reset_stats() so the next exercise
  starts from a clean reps=0/score=0 slate. Quitting still saves whatever
  exercise is active at that point, same as before -- so a full multi-
  exercise run now produces one saved session per exercise, instead of
  one merged/overwritten session for the whole run.

CHANGE LOG (flappy game removed):
- The neck_tilt "flappy owl" mini-game (armup_flappy.FlappyGame) has been
  removed entirely -- the import, the flappy.update()/set_vertical_control()/
  flap()/draw()/reset()/start() calls, and the "vertical control" derivation
  from nose height are all gone. Reason: MediaPipe pose detection + the
  smoothing filter + the HOLD_FRAMES_REQUIRED debounce together add roughly
  200-300ms of unavoidable latency, which made the fast-reaction obstacle
  game feel unresponsive/unfair (you'd already be too late by the time the
  game registered a tilt). neck_tilt is now a plain exercise like curl/
  raise/press -- same skeleton drawing, same NECK_BASE/VERTICAL_REF/NOSE
  angle fed into the engine, same rep/score/streak/accuracy tracking, same
  per-exercise save-on-switch -- it just no longer drives a game canvas.
  Gamification for neck_tilt is deferred to a future phase; armup_flappy.py
  itself was left untouched on disk in case it's revisited later.
"""

import os
os.environ["GLOG_minloglevel"] = "2"

import argparse
import cv2
import mediapipe as mp
import numpy as np
import time
import random
import urllib.request
import requests
from PIL import Image, ImageDraw, ImageFont
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

from armup_engine import SessionState, EXERCISES, angle_at, MIN_VISIBILITY

parser = argparse.ArgumentParser()
parser.add_argument("--user", type=int, default=None)
parser.add_argument("--exercise", type=str, default=None)
args = parser.parse_args()

# ---------- Backend integration ----------
API_URL = "http://localhost:8000"


def save_session_to_backend(user_id, session):
    """Best-effort POST to the backend. Never crashes the app if the
    server is offline or unreachable -- rehab shouldn't stop because
    the API isn't running."""
    if session.reps == 0:
        print("No reps recorded this run -- nothing to save.")
        return
    try:
        resp = requests.post(f"{API_URL}/sessions", json={
            "user_id": user_id,
            "exercise_key": session.exercise_key,
            "reps": session.reps,
            "score": session.score,
            "accuracy": session.accuracy(),
            "max_streak": session.max_streak,
            "level": session.level,
        }, timeout=2)
        if resp.status_code == 200:
            print(f"Session saved: {resp.json()}")
        else:
            print(f"Backend responded {resp.status_code}: {resp.text}")
    except requests.exceptions.RequestException as e:
        print(f"Could not reach backend ({e}) -- session not saved, but app continues fine.")


# ---------- Font setup (Poppins, matching Arya's font-family) ----------
FONT_PATH = "Poppins-Regular.ttf"
FONT_BOLD_PATH = "Poppins-SemiBold.ttf"
FONT_URLS = {
    FONT_PATH: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Regular.ttf",
    FONT_BOLD_PATH: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf",
}
for path, url in FONT_URLS.items():
    if not os.path.exists(path):
        try:
            print(f"Downloading {path} (one-time)...")
            urllib.request.urlretrieve(url, path)
        except Exception:
            pass  # falls back to default font below if offline

def _load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

FONT_TITLE = _load_font(FONT_BOLD_PATH, 40)
FONT_HEAD = _load_font(FONT_BOLD_PATH, 20)
FONT_BODY = _load_font(FONT_PATH, 16)
FONT_SMALL = _load_font(FONT_PATH, 13)


def to_pil(cv2_img):
    return Image.fromarray(cv2.cvtColor(cv2_img, cv2.COLOR_BGR2RGB))


def to_cv2(pil_img):
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


def draw_card(draw, xy, radius=14, fill=(30, 22, 40, 235), outline=None, shadow=True):
    """Rounded card with an optional soft shadow -- the PIL equivalent of
    Arya's CSS .card { border-radius; background: var(--card); box-shadow }"""
    x0, y0, x1, y1 = xy
    if shadow:
        draw.rounded_rectangle((x0 + 3, y0 + 4, x1 + 3, y1 + 4), radius=radius, fill=(0, 0, 0, 60))
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=1)

# ---------- Pose model setup ----------
MODEL_PATH = "pose_landmarker_lite.task"
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
if not os.path.exists(MODEL_PATH):
    print("Downloading pose model (one-time)...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)

base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
options = mp_vision.PoseLandmarkerOptions(
    base_options=base_options,
    running_mode=mp_vision.RunningMode.VIDEO,
    min_pose_detection_confidence=0.6,
    min_tracking_confidence=0.6,
)
landmarker = mp_vision.PoseLandmarker.create_from_options(options)

LM = {
    "NOSE": 0,
    "LEFT_SHOULDER": 11, "RIGHT_SHOULDER": 12,
    "LEFT_ELBOW": 13, "RIGHT_ELBOW": 14,
    "LEFT_WRIST": 15, "RIGHT_WRIST": 16,
    "LEFT_HIP": 23, "RIGHT_HIP": 24,
}

# Synthetic points used only by the neck_tilt exercise -- not raw
# MediaPipe landmarks, so they don't get a LM index above. They're
# derived fresh every frame from real landmarks (see main loop).
NECK_SYNTHETIC_POINTS = ("NECK_BASE", "VERTICAL_REF")

cap = cv2.VideoCapture(0)
FRAME_W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
FRAME_H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480

# ---------- User identity (backend integration) ----------
# If launched with --user (e.g. by the dashboard's Start Exercise button
# via the API's /start-session endpoint), skip the terminal prompt
# entirely -- it would otherwise block forever with no one there to type
# into it. Manual runs (no --user passed) keep the original prompt.
if args.user is not None:
    USER_ID = args.user
else:
    try:
        USER_ID = int(input("Enter your user id (from POST /users, e.g. 1): ") or "1")
    except ValueError:
        USER_ID = 1

COLOR_BG = (53, 16, 27)        # #1B1035 -> matches Arya's --bg1
COLOR_LIMB = (208, 224, 63)    # #3FE0D0 cyan -> Arya's connector color
COLOR_ACCENT = (139, 107, 255) # #FF6B8B coral -> Arya's landmark dot color
COLOR_TEXT = (250, 246, 243)   # #F3F6FA -> Arya's --text
COLOR_GOOD = (160, 224, 92)    # #5CE0A0 mint -> Arya's --mint
COLOR_WARN = (94, 193, 255)    # #FFC15E amber -> low-visibility warning
COLOR_STAR = (196, 168, 154)   # #9AA8C4 dim -> Arya's --dim

# Per-exercise swatch colors, matching Arya's exercise color-coding exactly
EXERCISE_COLORS = {
    "curl":  (139, 107, 255),   # coral #FF6B8B (BGR, for OpenCV skeleton bits)
    "raise": (255, 140, 91),    # blue  #5B8CFF
    "press": (255, 132, 176),   # purple #B084FF
    "neck_tilt": (94, 224, 213),  # sunny yellow #D5E05E (BGR), owl/alert color
}
EXERCISE_COLORS_RGB = {
    "curl":  (255, 107, 139),   # coral (RGB, for PIL text/cards)
    "raise": (91, 140, 255),    # blue
    "press": (176, 132, 255),   # purple
    "neck_tilt": (213, 224, 94),  # sunny yellow
}

UPPER_BODY_CONNECTIONS = [
    ("LEFT_SHOULDER", "RIGHT_SHOULDER"), ("LEFT_SHOULDER", "LEFT_ELBOW"),
    ("LEFT_ELBOW", "LEFT_WRIST"), ("RIGHT_SHOULDER", "RIGHT_ELBOW"),
    ("RIGHT_ELBOW", "RIGHT_WRIST"), ("LEFT_SHOULDER", "LEFT_HIP"),
    ("RIGHT_SHOULDER", "RIGHT_HIP"), ("LEFT_HIP", "RIGHT_HIP"),
]

STARS = [(random.randint(0, FRAME_W), random.randint(0, FRAME_H), random.uniform(0, 6.28)) for _ in range(35)]
smoothed_points = {}
SMOOTHING_ALPHA = 0.3  # slightly heavier smoothing than before (was 0.4) to further cut jitter


def smooth(name, raw_point):
    if name not in smoothed_points:
        smoothed_points[name] = raw_point
    else:
        prev = smoothed_points[name]
        smoothed_points[name] = (prev[0] + SMOOTHING_ALPHA * (raw_point[0] - prev[0]),
                                  prev[1] + SMOOTHING_ALPHA * (raw_point[1] - prev[1]))
    return int(smoothed_points[name][0]), int(smoothed_points[name][1])


def draw_glow_line(img, pt1, pt2, color, thickness=6):
    overlay = img.copy()
    cv2.line(overlay, pt1, pt2, color, thickness + 10)
    cv2.addWeighted(overlay, 0.25, img, 0.75, 0, img)
    cv2.line(img, pt1, pt2, color, thickness, lineType=cv2.LINE_AA)


def draw_stars(canvas, t):
    for (sx, sy, phase) in STARS:
        twinkle = (np.sin(t * 2 + phase) + 1) / 2
        cv2.circle(canvas, (sx, sy), 1 + int(twinkle * 2), COLOR_STAR, -1, lineType=cv2.LINE_AA)


def draw_neck_hint(canvas, x, y, t):
    """
    Animated demo for the neck_tilt exercise: a little owl-like head that
    tilts side to side on a fixed neck line, since the arm-swing animation
    used for curl/raise/press doesn't make sense for a head movement.
    """
    card_w, card_h = 230, 95
    overlay = canvas.copy()
    cv2.rectangle(overlay, (x, y), (x + card_w, y + card_h), (40, 30, 45), -1)
    cv2.addWeighted(overlay, 0.75, canvas, 0.25, 0, canvas)
    cv2.rectangle(canvas, (x, y), (x + card_w, y + card_h), COLOR_ACCENT, 1, lineType=cv2.LINE_AA)

    cx, cy = x + 42, y + 58
    swing = np.sin(t * 2.2)  # -1 .. 1, tilt left/right like an owl watching a branch
    tilt_deg = swing * 28    # matches roughly the exercise's peak angle

    neck_top = (cx, cy - 18)
    shoulders_l, shoulders_r = (cx - 16, cy + 14), (cx + 16, cy + 14)
    head_offset_x = int(np.sin(np.radians(tilt_deg)) * 20)
    head_offset_y = int((1 - np.cos(np.radians(tilt_deg))) * 20)
    head_c = (cx + head_offset_x, cy - 34 + head_offset_y)

    # neck + shoulders (static "body")
    cv2.line(canvas, neck_top, shoulders_l, (230, 230, 230), 2, lineType=cv2.LINE_AA)
    cv2.line(canvas, neck_top, shoulders_r, (230, 230, 230), 2, lineType=cv2.LINE_AA)
    cv2.line(canvas, neck_top, head_c, COLOR_ACCENT, 3, lineType=cv2.LINE_AA)

    # owl head with little "ear tuft" triangles for personality
    cv2.circle(canvas, head_c, 12, COLOR_ACCENT, 2, lineType=cv2.LINE_AA)
    tuft_dx, tuft_dy = 8, -8
    cv2.line(canvas, (head_c[0] - 6, head_c[1] - 10), (head_c[0] - 6 + tuft_dx, head_c[1] - 10 + tuft_dy), COLOR_ACCENT, 2, lineType=cv2.LINE_AA)
    cv2.line(canvas, (head_c[0] + 6, head_c[1] - 10), (head_c[0] + 6 - tuft_dx, head_c[1] - 10 + tuft_dy), COLOR_ACCENT, 2, lineType=cv2.LINE_AA)
    cv2.circle(canvas, (head_c[0] - 4, head_c[1] - 1), 2, (230, 230, 230), -1, lineType=cv2.LINE_AA)
    cv2.circle(canvas, (head_c[0] + 4, head_c[1] - 1), 2, (230, 230, 230), -1, lineType=cv2.LINE_AA)

    label = EXERCISES["neck_tilt"]["name"]
    cv2.putText(canvas, "Do a:", (x + 84, y + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (170, 220, 170), 1, cv2.LINE_AA)
    cv2.putText(canvas, label, (x + 84, y + 58), cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLOR_TEXT, 1, cv2.LINE_AA)
    cv2.putText(canvas, "-- follow the demo", (x + 84, y + 82), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (170, 220, 170), 1, cv2.LINE_AA)


def draw_pose_hint(canvas, x, y, t, exercise_key):
    """
    Small looping animated demo showing the CURRENT exercise -- for the
    arm exercises it swings from rest position to peak position and back;
    for neck_tilt it delegates to draw_neck_hint(), which animates a head
    tilting instead of an arm swinging. Either way the patient always has
    a live reference for what to do.
    """
    if exercise_key == "neck_tilt":
        draw_neck_hint(canvas, x, y, t)
        return

    card_w, card_h = 230, 95
    overlay = canvas.copy()
    cv2.rectangle(overlay, (x, y), (x + card_w, y + card_h), (40, 30, 45), -1)
    cv2.addWeighted(overlay, 0.75, canvas, 0.25, 0, canvas)
    cv2.rectangle(canvas, (x, y), (x + card_w, y + card_h), COLOR_ACCENT, 1, lineType=cv2.LINE_AA)

    cx, cy = x + 42, y + 58
    swing = (np.sin(t * 2.2) + 1) / 2  # 0 = rest pose, 1 = peak pose

    head_c = (cx, cy - 34)
    torso_top = (cx, cy - 22)
    torso_bottom = (cx, cy + 10)
    hip_l, hip_r = (cx - 6, cy + 10), (cx + 6, cy + 10)

    # Different rest/peak arm shapes per exercise, so the demo actually
    # matches what the engine is scoring.
    poses = {
        "curl":  {"rest_elbow": (cx - 16, cy - 4),  "peak_elbow": (cx - 16, cy - 4),
                  "rest_wrist": (cx - 24, cy + 12),  "peak_wrist": (cx - 8, cy - 20)},
        "raise": {"rest_elbow": (cx - 8, cy - 14),   "peak_elbow": (cx - 24, cy - 22),
                  "rest_wrist": (cx - 6, cy + 6),     "peak_wrist": (cx - 38, cy - 22)},
        "press": {"rest_elbow": (cx - 16, cy - 10),  "peak_elbow": (cx - 12, cy - 30),
                  "rest_wrist": (cx - 14, cy + 8),    "peak_wrist": (cx - 8, cy - 48)},
    }
    p = poses[exercise_key]
    elbow = (int(p["rest_elbow"][0] + (p["peak_elbow"][0] - p["rest_elbow"][0]) * swing),
              int(p["rest_elbow"][1] + (p["peak_elbow"][1] - p["rest_elbow"][1]) * swing))
    wrist = (int(p["rest_wrist"][0] + (p["peak_wrist"][0] - p["rest_wrist"][0]) * swing),
              int(p["rest_wrist"][1] + (p["peak_wrist"][1] - p["rest_wrist"][1]) * swing))

    cv2.circle(canvas, head_c, 7, (230, 230, 230), 2, lineType=cv2.LINE_AA)
    cv2.line(canvas, torso_top, torso_bottom, (230, 230, 230), 2, lineType=cv2.LINE_AA)
    cv2.line(canvas, torso_top, elbow, COLOR_ACCENT, 3, lineType=cv2.LINE_AA)
    cv2.line(canvas, elbow, wrist, COLOR_ACCENT, 3, lineType=cv2.LINE_AA)
    cv2.line(canvas, torso_bottom, hip_l, (230, 230, 230), 2, lineType=cv2.LINE_AA)
    cv2.line(canvas, torso_bottom, hip_r, (230, 230, 230), 2, lineType=cv2.LINE_AA)
    cv2.circle(canvas, wrist, 4, COLOR_ACCENT, -1, lineType=cv2.LINE_AA)

    label = EXERCISES[exercise_key]["name"]
    cv2.putText(canvas, "Do a:", (x + 84, y + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (170, 220, 170), 1, cv2.LINE_AA)
    cv2.putText(canvas, label, (x + 84, y + 58), cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLOR_TEXT, 1, cv2.LINE_AA)
    cv2.putText(canvas, "-- follow the demo", (x + 84, y + 82), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (170, 220, 170), 1, cv2.LINE_AA)


def draw_accuracy_ring(canvas, session, cx, cy, radius=34):
    """Circular progress ring showing accuracy, matching Arya's ring gauge element."""
    acc = session.accuracy()
    cv2.circle(canvas, (cx, cy), radius, (60, 45, 55), 6, lineType=cv2.LINE_AA)
    if acc > 0:
        end_angle = int(360 * (acc / 100))
        cv2.ellipse(canvas, (cx, cy), (radius, radius), -90, 0, end_angle,
                    COLOR_GOOD, 6, lineType=cv2.LINE_AA)
    cv2.putText(canvas, f"{acc}%", (cx - 20, cy + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLOR_TEXT, 2, cv2.LINE_AA)


def draw_hud_pil(canvas, session, feedback_flash, tracking_ok):
    """
    Renders the HUD (exercise chip, stats, instructions, feedback flash)
    using PIL instead of cv2.putText/cv2.rectangle -- gives real anti-aliased
    typography and rounded cards, matching the polish level of your other
    projects instead of OpenCV's blocky default text.
    """
    h, w = canvas.shape[:2]
    pil_img = to_pil(canvas).convert("RGBA")
    overlay = Image.new("RGBA", pil_img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    ex_color = EXERCISE_COLORS_RGB[session.exercise_key]
    ex_name = session.exercise["name"]

    # Exercise chip, top-left
    chip_w = 24 + int(draw.textlength(ex_name, font=FONT_HEAD)) + 20
    draw_card(draw, (14, 14, 14 + chip_w, 54), radius=16, fill=(30, 22, 40, 220), outline=ex_color + (255,))
    draw.ellipse((28, 27, 40, 39), fill=ex_color + (255,))
    draw.text((46, 24), ex_name, font=FONT_HEAD, fill=(243, 246, 250, 255))

    # Stats card, top-right
    stats = [("Score", session.score), ("Reps", session.reps),
             ("Streak", session.streak), ("Lvl", session.level)]
    stat_w = 78
    card_w = stat_w * len(stats) + 20
    x1 = w - 14
    x0 = x1 - card_w
    draw_card(draw, (x0, 14, x1, 66), radius=16, fill=(30, 22, 40, 220), outline=(255, 255, 255, 30))
    for i, (label, val) in enumerate(stats):
        cx = x0 + 10 + i * stat_w
        draw.text((cx, 22), str(val), font=FONT_HEAD, fill=(63, 224, 208, 255))
        draw.text((cx, 44), label.upper(), font=FONT_SMALL, fill=(154, 168, 196, 255))

    # Bottom instruction bar
    hint = "1 Curl   2 Lateral Raise   3 Shoulder Press   4 Neck Tilt   Q Quit"
    draw_card(draw, (14, h - 42, 14 + int(draw.textlength(hint, font=FONT_SMALL)) + 24, h - 14),
              radius=12, fill=(20, 15, 28, 190))
    draw.text((26, h - 36), hint, font=FONT_SMALL, fill=(154, 168, 196, 255))

    # Low-visibility warning -- tells the person WHY a rep might not be
    # counting, instead of silently ignoring their movement.
    if not tracking_ok:
        warn = "Step back / adjust lighting so your arm is clearly visible"
        ww = draw.textlength(warn, font=FONT_SMALL)
        draw_card(draw, (w/2 - ww/2 - 16, 70, w/2 + ww/2 + 16, 100), radius=12, fill=(45, 30, 20, 210))
        draw.text((w/2 - ww/2, 76), warn, font=FONT_SMALL, fill=(255, 193, 94, 255))

    # Feedback flash, top-center
    if feedback_flash and time.time() < feedback_flash["until"]:
        text = feedback_flash["text"]
        tw = draw.textlength(text, font=FONT_TITLE)
        cx = w // 2 - int(tw) // 2
        draw_card(draw, (cx - 20, 70, cx + int(tw) + 20, 118), radius=20, fill=(20, 40, 30, 210))
        draw.text((cx, 78), text, font=FONT_HEAD, fill=(92, 224, 160, 255))

    pil_img = Image.alpha_composite(pil_img, overlay)
    return to_cv2(pil_img.convert("RGB"))


def show_launch_screen():
    font_giant = _load_font(FONT_BOLD_PATH, 64)
    while True:
        canvas = np.full((FRAME_H, FRAME_W, 3), COLOR_BG, dtype=np.uint8)
        draw_stars(canvas, time.time())

        pil_img = to_pil(canvas).convert("RGBA")
        overlay = Image.new("RGBA", pil_img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        title = "ArmUp"
        tw = draw.textlength(title, font=font_giant)
        draw.text((FRAME_W // 2 - tw / 2, FRAME_H // 2 - 90), title, font=font_giant, fill=(63, 224, 208, 255))

        sub = "Press SPACE to start session"
        sw = draw.textlength(sub, font=FONT_HEAD)
        draw_card(draw, (FRAME_W // 2 - sw / 2 - 20, FRAME_H // 2 + 10,
                          FRAME_W // 2 + sw / 2 + 20, FRAME_H // 2 + 50), radius=14, fill=(30, 22, 40, 210))
        draw.text((FRAME_W // 2 - sw / 2, FRAME_H // 2 + 20), sub, font=FONT_HEAD, fill=(243, 246, 250, 255))

        pil_img = Image.alpha_composite(pil_img, overlay)
        canvas = to_cv2(pil_img.convert("RGB"))

        cv2.imshow("ArmUp", canvas)
        key = cv2.waitKey(30) & 0xFF
        if key == ord(' '):
            return True
        if key == ord('q'):
            return False


if not show_launch_screen():
    cap.release()
    cv2.destroyAllWindows()
    raise SystemExit

initial_exercise = args.exercise if args.exercise in EXERCISES else "curl"
session = SessionState(exercise_key=initial_exercise)
feedback_flash = None
last_frame_time = time.time()
start_time = time.time()
key_to_exercise = {ord('1'): "curl", ord('2'): "raise", ord('3'): "press", ord('4'): "neck_tilt"}

while cap.isOpened():
    now = time.time()
    last_frame_time = now
    success, frame = cap.read()
    if not success:
        break
    frame = cv2.flip(frame, 1)
    h, w, _ = frame.shape

    canvas = frame.copy()
    tint = np.full_like(canvas, COLOR_BG, dtype=np.uint8)
    cv2.addWeighted(canvas, 0.55, tint, 0.45, 0, canvas)
    draw_stars(canvas, time.time())

    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    frame_timestamp_ms = int((time.time() - start_time) * 1000)
    result = landmarker.detect_for_video(mp_image, frame_timestamp_ms)

    tracking_ok = True

    if result.pose_landmarks:
        landmarks = result.pose_landmarks[0]

        # Compute each landmark's smoothed point + visibility EXACTLY ONCE
        # per frame and cache it, instead of re-deriving it later for the
        # engine feed (which previously ran the smoothing filter twice on
        # the same raw sample).
        frame_points = {}
        frame_vis = {}
        for name, idx in LM.items():
            lm = landmarks[idx]
            frame_points[name] = smooth(name, (lm.x * w, lm.y * h))
            frame_vis[name] = getattr(lm, "visibility", 1.0)

        # ---- derive the synthetic neck_tilt points, once per frame ----
        # NECK_BASE = midpoint of the two shoulders (not a raw landmark).
        # VERTICAL_REF = a point straight above NECK_BASE, purely as a
        # "what does upright look like" reference for angle_at() to
        # measure against -- it never gets drawn as a real joint.
        ls, rs = frame_points["LEFT_SHOULDER"], frame_points["RIGHT_SHOULDER"]
        neck_base = smooth("NECK_BASE", ((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2))
        frame_points["NECK_BASE"] = neck_base
        frame_points["VERTICAL_REF"] = (neck_base[0], neck_base[1] - 100)
        # Synthetic points inherit trust from the real landmarks they're
        # built from -- if either shoulder is unreliable, so is NECK_BASE.
        shoulder_vis = min(frame_vis["LEFT_SHOULDER"], frame_vis["RIGHT_SHOULDER"])
        frame_vis["NECK_BASE"] = shoulder_vis
        frame_vis["VERTICAL_REF"] = shoulder_vis

        for a, b in UPPER_BODY_CONNECTIONS:
            draw_glow_line(canvas, frame_points[a], frame_points[b], COLOR_LIMB)
        drawn = set()
        for a, b in UPPER_BODY_CONNECTIONS:
            for name in (a, b):
                if name not in drawn:
                    drawn.add(name)
                    cv2.circle(canvas, frame_points[name], 6, COLOR_ACCENT, -1, lineType=cv2.LINE_AA)

        # Extra skeleton bit just for neck_tilt: a line from NECK_BASE up
        # to the NOSE, in the exercise's own color, so the tilt is visibly
        # obvious on screen instead of only showing up as a number.
        if session.exercise_key == "neck_tilt":
            draw_glow_line(canvas, neck_base, frame_points["NOSE"], EXERCISE_COLORS["neck_tilt"], thickness=4)
            cv2.circle(canvas, frame_points["NOSE"], 6, EXERCISE_COLORS["neck_tilt"], -1, lineType=cv2.LINE_AA)

        # ---- feed real coordinates into the ENGINE, not into UI logic ----
        n1, n2, n3 = session.exercise["landmarks"]
        # NOTE: mirrored frame -> use LEFT_* to track your physical right arm
        p1, p2, p3 = frame_points[n1], frame_points[n2], frame_points[n3]
        live_angle = angle_at(p1, p2, p3)

        tracking_ok = min(frame_vis[n1], frame_vis[n2], frame_vis[n3]) > MIN_VISIBILITY

        feedback = session.update(live_angle, landmarks_visible=tracking_ok)
        if feedback["event"] == "rep_complete":
            feedback_flash = {"text": feedback["message"], "until": time.time() + 1.0}

        angle_color = (200, 200, 200) if tracking_ok else (94, 193, 255)
        cv2.putText(canvas, f"Angle: {int(live_angle)} deg", (14, 70),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, angle_color, 1, cv2.LINE_AA)
    else:
        # No person detected at all this frame -- definitely don't trust it.
        tracking_ok = False
        session.update(0, landmarks_visible=False)

    # Pose demo card shows regardless of whether a person is detected yet,
    # so it's visible even before you step into frame.
    draw_pose_hint(canvas, w - 244, 60, time.time(), session.exercise_key)
    draw_accuracy_ring(canvas, session, w - 60, canvas.shape[0] - 80)

    canvas = draw_hud_pil(canvas, session, feedback_flash, tracking_ok)
    cv2.imshow("ArmUp", canvas)

    key = cv2.waitKey(5) & 0xFF
    if key == ord('q'):
        break
    if key in key_to_exercise and key_to_exercise[key] != session.exercise_key:
        # Save the exercise we're leaving BEFORE switching, so its reps/
        # score/streak aren't lost or overwritten by the next exercise.
        # save_session_to_backend() already no-ops on reps == 0, so
        # switching before doing any reps on the current exercise is safe.
        save_session_to_backend(USER_ID, session)
        session.set_exercise(key_to_exercise[key])
        session.reset_stats()

save_session_to_backend(USER_ID, session)
cap.release()
cv2.destroyAllWindows()