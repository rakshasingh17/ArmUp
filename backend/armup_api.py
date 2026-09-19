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
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

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

MIN_PASSWORD_LEN = 6  # keep in sync with SignupPage.jsx


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
    password: str
    ailment_tags: List[str] = []


class LoginRequest(BaseModel):
    name: str
    password: str


class UserResponse(BaseModel):
    id: int
    name: str
    ailment_tags: List[str]


class ConditionResponse(BaseModel):
    tag: str
    label: str
    exercises: List[str]


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


@app.get("/conditions", response_model=List[ConditionResponse])
def list_conditions(db: Session = Depends(get_db)):
    """Conditions offered in the signup dropdown, each with the exercises
    it prescribes. Comes straight from ailment_exercise_map."""
    return [ConditionResponse(**c) for c in db_layer.list_conditions(db)]


@app.post("/users", response_model=UserResponse)
def create_user(req: CreateUserRequest, db: Session = Depends(get_db)):
    """Signup. The prescribed plan isn't stored separately -- it's derived
    from the user's ailment_tags via ailment_exercise_map, so picking
    conditions here is what creates the plan."""
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Please enter your name.")
    if len(req.password) < MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at least {MIN_PASSWORD_LEN} characters.",
        )

    tags = list(dict.fromkeys(req.ailment_tags))  # drop duplicates, keep order
    if not tags:
        raise HTTPException(status_code=400, detail="Select at least one condition.")
    valid_tags = {c["tag"] for c in db_layer.list_conditions(db)}
    unknown = [t for t in tags if t not in valid_tags]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown condition: {unknown[0]}")

    if db_layer.get_user_by_name(db, name):
        raise HTTPException(
            status_code=409,
            detail="That name is already taken. Choose another, or log in if it's yours.",
        )

    user = db_layer.create_user(db, name, tags, req.password)
    return UserResponse(id=user.id, name=user.name, ailment_tags=user.tags())


@app.post("/login", response_model=UserResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db_layer.authenticate(db, req.name, req.password)
    if not user:
        # Same message for "no such name" and "wrong password" on purpose.
        raise HTTPException(status_code=401, detail="Incorrect name or password.")
    return UserResponse(id=user.id, name=user.name, ailment_tags=user.tags())


@app.get("/users/{user_id}", response_model=UserResponse)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db_layer.get_user(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse(id=user.id, name=user.name, ailment_tags=user.tags())


@app.get("/exercises", response_model=List[ExerciseResponse])
def list_all_exercises(db: Session = Depends(get_db)):
    """All available exercises -- for a generic exercise picker screen."""
    return [ExerciseResponse(key=e.key, name=e.name) for e in db_layer.list_exercises(db)]


@app.get("/users/{user_id}/exercises", response_model=List[ExerciseResponse])
def get_recommended_exercises(user_id: int, db: Session = Depends(get_db)):
    """The core 'ailment -> recommended exercises' endpoint Arya's
    exercise screen calls right after a user/ailment is selected."""
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
def save_session(req: LogSessionRequest, db: Session = Depends(get_db)):
    """Called once an exercise session ends -- saves reps/score/accuracy/etc."""
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
def get_user_sessions(user_id: int, db: Session = Depends(get_db)):
    """The therapist dashboard's main data source -- full session history
    for a patient, for charting progress/accuracy/reps over time."""
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
def start_session(user_id: int = 1, exercise_key: str = "curl", db: Session = Depends(get_db)):
    """Launches armup_app.py (the webcam engine) as a separate process,
    pre-filled with the given user and exercise -- called by the
    dashboard's 'Start Exercise' button."""
    if exercise_key not in EXERCISES:
        raise HTTPException(status_code=400, detail=f"Unknown exercise_key: {exercise_key}")
    if not db_layer.get_user(db, user_id):
        raise HTTPException(status_code=404, detail="User not found")

    subprocess.Popen([
        sys.executable, "armup_app.py",
        "--user", str(user_id),
        "--exercise", exercise_key,
    ])
    return {"status": "started", "user_id": user_id, "exercise_key": exercise_key}