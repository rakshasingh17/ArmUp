"""
ArmUp Database (SQLite)
------------------------
Data layer: users, exercises, session history, and the ailment -> exercise
recommendation mapping. Pure persistence -- no rep-detection or scoring
logic lives here (that stays in armup_engine.py). This file has zero
mediapipe/cv2 dependency, so any teammate can import it (or run armup_api.py)
without installing the vision stack.

Single local file (armup.db) -- no server, no Atlas account, no running
daemon. `python armup_db.py` proves it works standalone, same philosophy
as armup_engine.py's own __main__ test block.
"""
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

from armup_engine import EXERCISES  # source of truth for exercise names/keys

Base = declarative_base()
_engine = create_engine("sqlite:///armup.db")
SessionLocal = sessionmaker(bind=_engine)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    ailment_tags = Column(String, default="")  # comma-separated, e.g. "neck_stiffness,desk_posture"

    sessions = relationship("SessionLog", back_populates="user")

    def tags(self):
        return [t for t in self.ailment_tags.split(",") if t]


class Exercise(Base):
    """Mirrors armup_engine.EXERCISES so the frontend has a real table to
    query exercise names/descriptions from, instead of hardcoding them."""
    __tablename__ = "exercises"
    key = Column(String, primary_key=True)   # "curl" / "raise" / "press" / "neck_tilt"
    name = Column(String, nullable=False)


class SessionLog(Base):
    """One completed exercise session -- maps directly onto armup_engine.SessionState."""
    __tablename__ = "session_logs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    exercise_key = Column(String, ForeignKey("exercises.key"), nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow)
    reps = Column(Integer, default=0)
    score = Column(Integer, default=0)
    accuracy = Column(Float, default=0.0)
    max_streak = Column(Integer, default=0)
    level = Column(Integer, default=1)

    user = relationship("User", back_populates="sessions")


class AilmentExerciseMap(Base):
    """Rule-based, editable lookup table -- a therapist could adjust this
    data without touching any code. Deliberately NOT a trained model."""
    __tablename__ = "ailment_exercise_map"
    id = Column(Integer, primary_key=True)
    ailment_tag = Column(String, nullable=False)
    exercise_key = Column(String, ForeignKey("exercises.key"), nullable=False)
    starting_tolerance = Column(Float, nullable=True)  # wider = gentler starting difficulty
    priority = Column(Integer, default=1)              # lower shown first


def init_db():
    Base.metadata.create_all(_engine)


# ---------------------------------------------------------------
# CRUD / query helpers
# ---------------------------------------------------------------
def create_user(db, name, ailment_tags=None):
    user = User(name=name, ailment_tags=",".join(ailment_tags or []))
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def get_user(db, user_id):
    return db.get(User, user_id)


def list_exercises(db):
    return db.query(Exercise).all()


def log_session(db, user_id, exercise_key, reps, score, accuracy, max_streak, level):
    """Plain-field version -- used by the API (HTTP request body) and by
    any Python caller. If you're logging directly from a live
    armup_engine.SessionState in the desktop app, just unpack it:
        log_session(db, user_id, s.exercise_key, s.reps, s.score,
                    s.accuracy(), s.max_streak, s.level)
    """
    entry = SessionLog(
        user_id=user_id, exercise_key=exercise_key, reps=reps, score=score,
        accuracy=accuracy, max_streak=max_streak, level=level,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def get_history(db, user_id):
    return (db.query(SessionLog)
              .filter(SessionLog.user_id == user_id)
              .order_by(SessionLog.timestamp)
              .all())


def get_recommended_exercises(db, user_id):
    user = get_user(db, user_id)
    if not user or not user.tags():
        return []
    return (db.query(AilmentExerciseMap)
              .filter(AilmentExerciseMap.ailment_tag.in_(user.tags()))
              .order_by(AilmentExerciseMap.priority)
              .all())


# ---------------------------------------------------------------
# Seed data
# ---------------------------------------------------------------
SEED_AILMENT_MAP = [
    ("frozen_shoulder", "raise", 20.0, 1),
    ("frozen_shoulder", "press", 20.0, 2),
    ("cervical_spondylosis", "neck_tilt", 10.0, 1),
    ("neck_stiffness", "neck_tilt", 10.0, 1),
    ("post_stroke_upper_limb", "curl", 22.0, 1),
    ("post_stroke_upper_limb", "raise", 22.0, 2),
    ("desk_posture", "neck_tilt", 10.0, 1),
    ("desk_posture", "raise", 15.0, 2),
]


def seed_exercises(db):
    if db.query(Exercise).first():
        return
    for key, data in EXERCISES.items():
        db.add(Exercise(key=key, name=data["name"]))
    db.commit()


def seed_ailment_map(db):
    if db.query(AilmentExerciseMap).first():
        return
    for tag, ex, tol, pri in SEED_AILMENT_MAP:
        db.add(AilmentExerciseMap(ailment_tag=tag, exercise_key=ex,
                                   starting_tolerance=tol, priority=pri))
    db.commit()


def seed_all(db):
    seed_exercises(db)
    seed_ailment_map(db)


if __name__ == "__main__":
    init_db()
    db = SessionLocal()
    seed_all(db)

    user = create_user(db, "Test User", ailment_tags=["neck_stiffness"])
    print(f"Created user: {user.name} (id={user.id}, tags={user.tags()})")

    recs = get_recommended_exercises(db, user.id)
    print("Recommended exercises:", [(r.exercise_key, r.priority) for r in recs])

    log_session(db, user.id, "neck_tilt", reps=8, score=96, accuracy=100.0, max_streak=5, level=2)
    history = get_history(db, user.id)
    print(f"History entries: {len(history)} -- last: {history[-1].exercise_key}, "
          f"reps={history[-1].reps}, accuracy={history[-1].accuracy}%")