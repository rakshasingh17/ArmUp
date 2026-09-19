"""
ArmUp API
---------
Thin HTTP layer over armup_db.py, for Bhakti's therapist dashboard and
Arya's exercise screen to consume from React (fetch/axios) instead of
importing Python directly.

Run it:
    pip install fastapi uvicorn sqlalchemy pydantic
    uvicorn armup_api:app --reload --port 8000

Then open http://localhost:8000/docs -- FastAPI auto-generates an
interactive Swagger page there, so Bhakti/Arya can try every endpoint
in the browser without asking you how to call it.
"""
from typing import List, Optional
import subprocess
import sys
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import armup_db as db_layer
from armup_engine import EXERCISES

app = FastAPI(title="ArmUp API")

# Dev-mode CORS: allows any localhost React dev server (Vite default 5173,
# CRA default 3000) to call this without CORS errors during the sprint.
# Tighten allow_origins to your actual deployed frontend URL before demo day.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

db_layer.init_db()
_seed_session = db_layer.SessionLocal()
db_layer.seed_all(_seed_session)
_seed_session.close()


def get_db():
    db = db_layer.SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------
# Request/response schemas
# ---------------------------------------------------------------
class CreateUserRequest(BaseModel):
    name: str
    ailment_tags: Optional[List[str]] = []


class UserResponse(BaseModel):
    id: int
    name: str
    ailment_tags: List[str]


class ExerciseResponse(BaseModel):
    key: str
    name: str
    priority: Optional[int] = None
    starting_tolerance: Optional[float] = None


class LogSessionRequest(BaseModel):
    user_id: int
    exercise_key: str
    reps: int
    score: int
    accuracy: float
    max_streak: int
    level: int


class SessionResponse(BaseModel):
    id: int
    exercise_key: str
    timestamp: str
    reps: int
    score: int
    accuracy: float
    max_streak: int
    level: int


# ---------------------------------------------------------------
# Routes
# ---------------------------------------------------------------
@app.get("/")
def health_check():
    return {"status": "ok", "service": "armup-api"}


@app.post("/users", response_model=UserResponse)
def create_user(req: CreateUserRequest, db=None):
    db = next(get_db())
    user = db_layer.create_user(db, req.name, req.ailment_tags)
    return UserResponse(id=user.id, name=user.name, ailment_tags=user.tags())


@app.get("/users/{user_id}", response_model=UserResponse)
def get_user(user_id: int):
    db = next(get_db())
    user = db_layer.get_user(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse(id=user.id, name=user.name, ailment_tags=user.tags())


@app.get("/exercises", response_model=List[ExerciseResponse])
def list_all_exercises():
    """All available exercises -- for a generic exercise picker screen."""
    db = next(get_db())
    return [ExerciseResponse(key=e.key, name=e.name) for e in db_layer.list_exercises(db)]


@app.get("/users/{user_id}/exercises", response_model=List[ExerciseResponse])
def get_recommended_exercises(user_id: int):
    """The core 'ailment -> recommended exercises' endpoint Arya's
    exercise screen calls right after a user/ailment is selected."""
    db = next(get_db())
    if not db_layer.get_user(db, user_id):
        raise HTTPException(status_code=404, detail="User not found")

    exercise_names = {e.key: e.name for e in db_layer.list_exercises(db)}
    recs = db_layer.get_recommended_exercises(db, user_id)
    return [
        ExerciseResponse(key=r.exercise_key, name=exercise_names.get(r.exercise_key, r.exercise_key),
                          priority=r.priority, starting_tolerance=r.starting_tolerance)
        for r in recs
    ]


@app.post("/sessions", response_model=SessionResponse)
def save_session(req: LogSessionRequest):
    """Called once an exercise session ends -- saves reps/score/accuracy/etc."""
    db = next(get_db())
    if not db_layer.get_user(db, req.user_id):
        raise HTTPException(status_code=404, detail="User not found")

    entry = db_layer.log_session(
        db, req.user_id, req.exercise_key, req.reps, req.score,
        req.accuracy, req.max_streak, req.level,
    )
    return SessionResponse(
        id=entry.id, exercise_key=entry.exercise_key, timestamp=entry.timestamp.isoformat(),
        reps=entry.reps, score=entry.score, accuracy=entry.accuracy,
        max_streak=entry.max_streak, level=entry.level,
    )


@app.get("/users/{user_id}/sessions", response_model=List[SessionResponse])
def get_user_sessions(user_id: int):
    """The therapist dashboard's main data source -- full session history
    for a patient, for charting progress/accuracy/reps over time."""
    db = next(get_db())
    if not db_layer.get_user(db, user_id):
        raise HTTPException(status_code=404, detail="User not found")

    history = db_layer.get_history(db, user_id)
    return [
        SessionResponse(
            id=s.id, exercise_key=s.exercise_key, timestamp=s.timestamp.isoformat(),
            reps=s.reps, score=s.score, accuracy=s.accuracy,
            max_streak=s.max_streak, level=s.level,
        )
        for s in history
    ]


@app.post("/start-session")
def start_session(user_id: int = 1, exercise_key: str = "curl"):
    """Launches armup_app.py (the webcam engine) as a separate process,
    pre-filled with the given user and exercise -- called by the
    dashboard's 'Start Exercise' button."""
    if exercise_key not in EXERCISES:
        raise HTTPException(status_code=400, detail=f"Unknown exercise_key: {exercise_key}")
    if not db_layer.get_user(next(get_db()), user_id):
        raise HTTPException(status_code=404, detail="User not found")

    subprocess.Popen([
        sys.executable, "armup_app.py",
        "--user", str(user_id),
        "--exercise", exercise_key,
    ])
    return {"status": "started", "user_id": user_id, "exercise_key": exercise_key}