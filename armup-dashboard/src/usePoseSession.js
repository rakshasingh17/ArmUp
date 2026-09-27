/*
 * usePoseSession.js
 * -----------------
 * The browser replacement for backend/armup_app.py's camera loop --
 * getUserMedia + MediaPipe PoseLandmarker + engine.js, wrapped as one
 * React hook so BOTH ExerciseCanvas.jsx and GameCanvas.jsx can drive
 * off the exact same camera stream and SessionState instance.
 *
 * ARCHITECTURE CHANGE (round 2 -- see chat history): the previous two
 * versions of this hook fed poseLandmarker.detectForVideo() the raw
 * <video> element directly, with that video forced to 1px x 1px and
 * parked off-screen. That is NOT what pose-test.html (the one file
 * that's actually proven to work) does -- it always draws the mirrored
 * frame into a real, properly-sized <canvas> first and detects off
 * THAT canvas. A near-invisible <video> element is a real landmine for
 * some browsers' GPU/WebGL frame-upload path: videoWidth/videoHeight
 * still report the true stream resolution, but the actual pixel data
 * fed to WebGL can be black/stale, silently, forever -- no thrown
 * error, no skeleton, no rep counting, exactly matching the reported
 * symptoms. (A try/catch around detectForVideo, tried first, could
 * only ever have caught an actual exception -- it can't fix "correctly
 * returns zero landmarks every single frame".)
 *
 * Fix: this hook now owns its own internal canvas (poseCanvasRef),
 * sized to the camera's real resolution, never attached to the
 * visible DOM. Every detection tick: mirror-draw video -> this canvas,
 * then detectForVideo(canvas, ...) -- never the video. Consumers
 * (ExerciseCanvas, GameCanvas) draw FROM poseCanvasRef instead of from
 * videoRef -- it's already mirrored, so their own ctx.translate/
 * ctx.scale(-1,1) mirroring code goes away, and landmark coordinates
 * map onto it 1:1 with no separate "mirror in code" math needed.
 *
 * Lives at the ArmUpDashboard level (called once, passed down as a
 * prop) rather than inside each canvas, on purpose: mounting it twice
 * would mean two separate getUserMedia prompts and two independent
 * rep counters the instant someone switched from Exercise mode to
 * Game mode. One hook instance = one camera + one running session
 * that just gets drawn two different ways.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionState, EXERCISES, FORM_RULES, angleAt, MIN_VISIBILITY } from './engine';

const MP_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// Same landmark index map as backend/armup_app.py's LM dict --
// PoseLandmarker's index scheme is identical between Python and JS.
const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
};

export const UPPER_BODY_CONNECTIONS = [
  ["LEFT_SHOULDER", "RIGHT_SHOULDER"], ["LEFT_SHOULDER", "LEFT_ELBOW"],
  ["LEFT_ELBOW", "LEFT_WRIST"], ["RIGHT_SHOULDER", "RIGHT_ELBOW"],
  ["RIGHT_ELBOW", "RIGHT_WRIST"], ["LEFT_SHOULDER", "LEFT_HIP"],
  ["RIGHT_SHOULDER", "RIGHT_HIP"], ["LEFT_HIP", "RIGHT_HIP"],
];

const SMOOTHING_ALPHA = 0.3; // same as Python's / pose-test.html's smooth()

function smooth(store, name, raw) {
  if (!store[name]) store[name] = { x: raw.x, y: raw.y };
  else {
    store[name].x += SMOOTHING_ALPHA * (raw.x - store[name].x);
    store[name].y += SMOOTHING_ALPHA * (raw.y - store[name].y);
  }
  return store[name];
}

const EMPTY_STATS = { score: 0, reps: 0, streak: 0, maxStreak: 0, level: 1, accuracy: 0 };

export function usePoseSession({ initialExercise = 'curl' } = {}) {
  const videoRef = useRef(null);        // hidden <video> -- drawImage() source only, NEVER passed to MediaPipe
  const poseCanvasRef = useRef(null);   // real-size internal canvas -- both mirror-draw target AND detection source
  const streamRef = useRef(null);
  const poseLandmarkerRef = useRef(null);
  const rafRef = useRef(null);
  const smoothedRef = useRef({});
  const sessionRef = useRef(new SessionState({ exerciseKey: initialExercise }));

  const framePointsRef = useRef({});
  const frameVisRef = useRef({});
  const progressRef = useRef(0); // 0..1, how close the live angle is to peak
  const liveAngleRef = useRef(null); // raw degrees for the CURRENT exercise's landmark triple -- for tuning EXERCISES.rest/peak against your actual camera setup, not shown by default

  const [exerciseKey, setExerciseKeyState] = useState(initialExercise);
  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState('Camera not started.');
  const [error, setError] = useState(null);
  const [videoSize, setVideoSize] = useState({ width: 640, height: 480 });
  const [stats, setStats] = useState(EMPTY_STATS);
  const [trackingOk, setTrackingOk] = useState(false);
  const [partiallyVisible, setPartiallyVisible] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [formMessage, setFormMessage] = useState(null);
  const [fps, setFps] = useState(0);

  const statsRef = useRef(EMPTY_STATS);
  const fpsTimesRef = useRef([]);
  const lastFpsPushRef = useRef(0);
  const detectFailStreakRef = useRef(0);
  const lastTimestampRef = useRef(0);

  const setExercise = useCallback((key) => {
    if (!EXERCISES[key] || key === sessionRef.current.exerciseKey) return;
    sessionRef.current.setExercise(key);
    sessionRef.current.resetStats();
    progressRef.current = 0;
    setExerciseKeyState(key);
    statsRef.current = EMPTY_STATS;
    setStats(EMPTY_STATS);
  }, []);

  const resetStats = useCallback(() => {
    sessionRef.current.resetStats();
    statsRef.current = EMPTY_STATS;
    setStats(EMPTY_STATS);
  }, []);

  const getSnapshot = useCallback(() => ({ ...statsRef.current, exerciseKey: sessionRef.current.exerciseKey }), []);

  const startCamera = useCallback(async () => {
    if (cameraOn || starting) return;
    setStarting(true);
    try {
      setError(null);
      setStatus('Requesting camera access...');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      streamRef.current = stream;

      let video = videoRef.current;
      if (!video) {
        // Same treatment as pose-test.html's <video id="webcam"> --
        // display:none, never given a forced tiny CSS size. It's only
        // ever used as a drawImage() source below, never passed to
        // MediaPipe directly, so its own render size is irrelevant.
        video = document.createElement('video');
        video.playsInline = true;
        video.muted = true;
        video.setAttribute('aria-hidden', 'true');
        video.style.display = 'none';
        document.body.appendChild(video);
        videoRef.current = video;
      }
      video.srcObject = stream;
      await new Promise((resolve) => { video.onloadedmetadata = resolve; });
      await video.play();
      setVideoSize({ width: video.videoWidth, height: video.videoHeight });

      // Internal detached canvas, sized to the camera's real
      // resolution -- this, not the video, is what gets mirrored and
      // fed to MediaPipe. Detached (never appended to the DOM) is
      // fine: a canvas's 2D context works the same either way.
      if (!poseCanvasRef.current) {
        poseCanvasRef.current = document.createElement('canvas');
      }
      poseCanvasRef.current.width = video.videoWidth;
      poseCanvasRef.current.height = video.videoHeight;

      setStatus('Loading pose model (first load can take a few seconds)...');
      const visionModule = await import(/* @vite-ignore */ MP_CDN);
      const { PoseLandmarker, FilesetResolver } = visionModule;
      const filesetResolver = await FilesetResolver.forVisionTasks(`${MP_CDN}/wasm`);

      let landmarker;
      try {
        landmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          minPoseDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
      } catch (gpuErr) {
        console.warn('usePoseSession: GPU delegate failed, falling back to CPU:', gpuErr);
        landmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          minPoseDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
      }
      poseLandmarkerRef.current = landmarker;

      setStatus('Tracking. Step back so your upper body is fully visible.');
      setCameraOn(true);
    } catch (err) {
      console.error('usePoseSession: failed to start camera', err);
      setError(err?.message || String(err));
      setStatus('Failed to start camera.');
      setCameraOn(false);
    } finally {
      setStarting(false);
    }
  }, [cameraOn, starting]);

  const stopCamera = useCallback(() => {
    setCameraOn(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (poseLandmarkerRef.current) {
      poseLandmarkerRef.current.close?.();
      poseLandmarkerRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.remove();
      videoRef.current = null;
    }
    poseCanvasRef.current = null;
    framePointsRef.current = {};
    frameVisRef.current = {};
    progressRef.current = 0;
    smoothedRef.current = {};
    setStatus('Camera stopped.');
    setTrackingOk(false);
    setPartiallyVisible(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  useEffect(() => {
    if (!cameraOn) return undefined;
    let cancelled = false;

    const loop = (t) => {
      if (cancelled) return;
      const video = videoRef.current;
      const poseCanvas = poseCanvasRef.current;
      const poseLandmarker = poseLandmarkerRef.current;

      if (video && poseCanvas && poseLandmarker && video.readyState >= 2) {
        // Mirror the frame onto OUR canvas first -- same trick as
        // pose-test.html and backend's cv2.flip(frame, 1). Landmarks
        // come out already mirrored, so LEFT_* = the user's physical
        // right side, and this canvas is what consumers draw from.
        const pctx = poseCanvas.getContext('2d');
        pctx.save();
        pctx.translate(poseCanvas.width, 0);
        pctx.scale(-1, 1);
        pctx.drawImage(video, 0, 0, poseCanvas.width, poseCanvas.height);
        pctx.restore();

        // Detect FROM THE CANVAS, never from the video element.
        const ts = Math.max(performance.now(), lastTimestampRef.current + 1);
        lastTimestampRef.current = ts;

        let result = null;
        try {
          result = poseLandmarker.detectForVideo(poseCanvas, ts);
          detectFailStreakRef.current = 0;
        } catch (err) {
          detectFailStreakRef.current += 1;
          if (detectFailStreakRef.current <= 3 || detectFailStreakRef.current % 60 === 0) {
            console.error('usePoseSession: detectForVideo failed', err);
          }
          if (detectFailStreakRef.current === 30) {
            setError('Pose detection is failing repeatedly -- try restarting the camera.');
          }
        }

        const cw = poseCanvas.width, ch = poseCanvas.height;
        let ok = false;
        let personDetected = false;

        if (result && result.landmarks && result.landmarks.length > 0) {
          personDetected = true;
          const landmarks = result.landmarks[0];
          const framePoints = {};
          const frameVis = {};
          for (const [name, idx] of Object.entries(LM)) {
            const lm = landmarks[idx];
            // Canvas is ALREADY mirrored (drawn that way above), so
            // landmark x/y map onto it directly -- no extra mirror
            // math needed, unlike the previous version.
            const px = { x: lm.x * cw, y: lm.y * ch };
            framePoints[name] = smooth(smoothedRef.current, name, px);
            frameVis[name] = lm.visibility ?? 1.0;
          }

          const ls = framePoints.LEFT_SHOULDER, rs = framePoints.RIGHT_SHOULDER;
          const neckBaseRaw = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
          const neckBase = smooth(smoothedRef.current, 'NECK_BASE', neckBaseRaw);
          framePoints.NECK_BASE = neckBase;
          framePoints.VERTICAL_REF = { x: neckBase.x, y: neckBase.y - 100 };
          const shoulderVis = Math.min(frameVis.LEFT_SHOULDER, frameVis.RIGHT_SHOULDER);
          frameVis.NECK_BASE = shoulderVis;
          frameVis.VERTICAL_REF = shoulderVis;

          framePointsRef.current = framePoints;
          frameVisRef.current = frameVis;

          const session = sessionRef.current;
          const ex = session.exercise;
          const [n1, n2, n3] = ex.landmarks;
          const liveAngle = angleAt(framePoints[n1], framePoints[n2], framePoints[n3]);
          liveAngleRef.current = liveAngle;
          ok = Math.min(frameVis[n1], frameVis[n2], frameVis[n3]) > MIN_VISIBILITY;

          const span = ex.peak - ex.rest;
          const rawProgress = span ? (liveAngle - ex.rest) / span : 0;
          progressRef.current = Math.max(0, Math.min(1, rawProgress));

          const fb = session.update(liveAngle, ok);
          if (fb.event !== 'none') {
            setFeedback({ ...fb, at: performance.now() });
          }

          if (ok) {
            const formAngles = {};
            for (const rule of (FORM_RULES[session.exerciseKey] || [])) {
              const [ra, rb, rc] = rule.pts;
              if (framePoints[ra] && framePoints[rb] && framePoints[rc]) {
                formAngles[rule.id] = angleAt(framePoints[ra], framePoints[rb], framePoints[rc]);
              }
            }
            const formMsg = session.checkForm(formAngles);
            if (formMsg) setFormMessage({ message: formMsg, at: performance.now() });
          }

          const nextStats = {
            score: session.score, reps: session.reps, streak: session.streak,
            maxStreak: session.maxStreak, level: session.level, accuracy: session.accuracy(),
          };
          const prev = statsRef.current;
          if (prev.score !== nextStats.score || prev.reps !== nextStats.reps ||
              prev.streak !== nextStats.streak || prev.level !== nextStats.level ||
              prev.accuracy !== nextStats.accuracy) {
            statsRef.current = nextStats;
            setStats(nextStats);
          }
        } else {
          framePointsRef.current = {};
          frameVisRef.current = {};
          liveAngleRef.current = null;
          sessionRef.current.update(0, false);
          progressRef.current = 0;
        }

        setTrackingOk((prevOk) => (prevOk !== ok ? ok : prevOk));
        setPartiallyVisible((prev) => {
          const next = personDetected && !ok;
          return prev !== next ? next : prev;
        });

        fpsTimesRef.current.push(t);
        while (fpsTimesRef.current.length > 30) fpsTimesRef.current.shift();
        if (t - lastFpsPushRef.current > 400 && fpsTimesRef.current.length > 1) {
          lastFpsPushRef.current = t;
          const arr = fpsTimesRef.current;
          setFps(Math.round((arr.length - 1) / ((arr[arr.length - 1] - arr[0]) / 1000)));
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [cameraOn]);

  return {
    videoRef, poseCanvasRef, framePointsRef, frameVisRef, progressRef, liveAngleRef, sessionRef,
    exerciseKey, setExercise,
    cameraOn, starting, startCamera, stopCamera,
    status, error, videoSize,
    stats, resetStats, getSnapshot,
    trackingOk, partiallyVisible,
    feedback, formMessage, fps,
  };
}