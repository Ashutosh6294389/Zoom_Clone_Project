"""Zoom clone API - FastAPI + SQLAlchemy + PostgreSQL."""

import os
import random
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
)
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker


# ============================================================
# DATABASE
# ============================================================

DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,

    # Important for Vercel + Supabase
    # Prevents too many PostgreSQL connections.
    pool_size=1,
    max_overflow=0,
    pool_recycle=300,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)

Base = declarative_base()


def now():
    """
    Store UTC as a naive datetime because our SQLAlchemy
    DateTime columns are timezone-naive.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ============================================================
# DATABASE MODELS
# ============================================================

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    email = Column(String(120), unique=True, nullable=False)

    meetings = relationship(
        "Meeting",
        back_populates="host"
    )


class Meeting(Base):
    __tablename__ = "meetings"

    id = Column(Integer, primary_key=True)

    code = Column(
        String(10),
        unique=True,
        index=True,
        nullable=False
    )

    title = Column(
        String(200),
        nullable=False
    )

    description = Column(
        Text,
        default=""
    )

    host_id = Column(
        Integer,
        ForeignKey("users.id"),
        nullable=False
    )

    # instant | scheduled
    kind = Column(
        String(10),
        default="scheduled"
    )

    # scheduled | live | ended
    status = Column(
        String(10),
        default="scheduled"
    )

    scheduled_start = Column(
        DateTime,
        nullable=False
    )

    duration_min = Column(
        Integer,
        default=30
    )

    started_at = Column(DateTime)
    ended_at = Column(DateTime)

    created_at = Column(
        DateTime,
        default=now
    )

    host = relationship(
        "User",
        back_populates="meetings"
    )

    participants = relationship(
        "Participant",
        back_populates="meeting",
        cascade="all, delete-orphan"
    )


class Participant(Base):
    __tablename__ = "participants"

    id = Column(Integer, primary_key=True)

    meeting_id = Column(
        Integer,
        ForeignKey("meetings.id"),
        nullable=False,
        index=True
    )

    # NULL for guests
    user_id = Column(
        Integer,
        ForeignKey("users.id")
    )

    display_name = Column(
        String(100),
        nullable=False
    )

    is_host = Column(
        Boolean,
        default=False
    )

    is_muted = Column(
        Boolean,
        default=False
    )

    # joined | left | removed
    status = Column(
        String(10),
        default="joined"
    )

    joined_at = Column(
        DateTime,
        default=now
    )

    left_at = Column(DateTime)

    meeting = relationship(
        "Meeting",
        back_populates="participants"
    )


# Create tables if they don't already exist.
Base.metadata.create_all(engine)


# ============================================================
# DATABASE DEPENDENCY
# ============================================================

def db():
    session = SessionLocal()

    try:
        yield session
    finally:
        session.close()


# ============================================================
# HELPERS
# ============================================================

def iso(dt):
    if dt:
        return dt.isoformat() + "Z"

    return None


def normalize_code(raw: str) -> str:
    raw = raw.strip()

    # Handle invite links:
    # https://domain.com/meeting/1234567890
    if "/meeting/" in raw:
        raw = raw.split("/meeting/")[1].split("?")[0]

    # Keep only digits
    return re.sub(r"\D", "", raw)


def new_code(session: Session) -> str:
    while True:
        code = str(
            random.randint(
                10**9,
                10**10 - 1
            )
        )

        existing = (
            session
            .query(Meeting)
            .filter_by(code=code)
            .first()
        )

        if not existing:
            return code


def meeting_out(meeting: Meeting):
    return {
        "id": meeting.id,
        "code": meeting.code,
        "title": meeting.title,
        "description": meeting.description,
        "host": meeting.host.name,
        "kind": meeting.kind,
        "status": meeting.status,
        "scheduled_start": iso(meeting.scheduled_start),
        "duration_min": meeting.duration_min,
        "started_at": iso(meeting.started_at),
        "ended_at": iso(meeting.ended_at),

        "participant_count": sum(
            1
            for participant in meeting.participants
            if participant.status == "joined"
        ),
    }


def part_out(participant: Participant):
    return {
        "id": participant.id,
        "display_name": participant.display_name,
        "is_host": participant.is_host,
        "is_muted": participant.is_muted,
        "status": participant.status,
    }


def get_meeting(
    session: Session,
    code: str
):
    meeting = (
        session
        .query(Meeting)
        .filter_by(
            code=normalize_code(code)
        )
        .first()
    )

    if not meeting:
        raise HTTPException(
            status_code=404,
            detail="Invalid meeting ID. Please check and try again."
        )

    return meeting


# ============================================================
# SEED DATABASE
# ============================================================

def seed():
    session = SessionLocal()

    try:
        # Don't seed again if users already exist.
        if session.query(User).count():
            return

        user = User(
            name="Demo User",
            email="demo@zoomclone.dev"
        )

        session.add(user)
        session.flush()

        base_time = now().replace(
            minute=0,
            second=0,
            microsecond=0
        )

        rows = [
            (
                "Weekly Team Sync",
                "Status updates and blockers",
                1,
                60,
                "scheduled"
            ),
            (
                "Design Review",
                "Review the new dashboard mockups",
                26,
                45,
                "scheduled"
            ),
            (
                "Sprint Planning",
                "Plan next sprint's backlog",
                50,
                90,
                "scheduled"
            ),
            (
                "Client Onboarding Call",
                "Kickoff with new client",
                75,
                30,
                "scheduled"
            ),
            (
                "1:1 with Manager",
                "Career growth discussion",
                -24,
                30,
                "ended"
            ),
            (
                "Product Demo",
                "Quarterly product demo",
                -48,
                60,
                "ended"
            ),
            (
                "Interview: Frontend Engineer",
                "Technical round",
                -72,
                45,
                "ended"
            ),
        ]

        for title, description, offset, duration, status in rows:

            start = (
                base_time
                + timedelta(hours=offset)
            )

            meeting = Meeting(
                code=new_code(session),
                title=title,
                description=description,
                host_id=user.id,
                kind="scheduled",
                status=status,
                scheduled_start=start,
                duration_min=duration,
            )

            if status == "ended":
                meeting.started_at = start

                meeting.ended_at = (
                    start
                    + timedelta(minutes=duration)
                )

            session.add(meeting)
            session.flush()

            if status == "ended":

                participants = [
                    ("Demo User", True),
                    ("Priya Sharma", False),
                    ("Rahul Verma", False),
                ]

                for name, is_host in participants:

                    session.add(
                        Participant(
                            meeting_id=meeting.id,
                            display_name=name,
                            is_host=is_host,
                            status="left",
                            joined_at=start,
                        )
                    )

        session.commit()

    finally:
        session.close()


seed()


# ============================================================
# FASTAPI
# ============================================================

app = FastAPI(
    title="Zoom Clone API"
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Demo application:
# no authentication yet.
DEFAULT_USER_ID = 1


# ============================================================
# REQUEST SCHEMAS
# ============================================================

class InstantIn(BaseModel):
    title: Optional[str] = None


class ScheduleIn(BaseModel):
    title: str
    description: str = ""
    start: datetime
    duration_min: int = 30


class JoinIn(BaseModel):
    display_name: str
    as_host: bool = False


class MuteIn(BaseModel):
    is_muted: bool


# ============================================================
# USER
# ============================================================

@app.get("/api/me")
def me(
    session: Session = Depends(db)
):
    user = session.get(
        User,
        DEFAULT_USER_ID
    )

    if not user:
        raise HTTPException(
            status_code=404,
            detail="User not found"
        )

    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
    }


# ============================================================
# MEETINGS
# ============================================================

@app.get("/api/meetings/upcoming")
def upcoming(
    session: Session = Depends(db)
):

    meetings = (
        session
        .query(Meeting)
        .filter(
            Meeting.status == "scheduled",
            Meeting.host_id == DEFAULT_USER_ID,
            Meeting.scheduled_start
            >= now() - timedelta(hours=1),
        )
        .order_by(
            Meeting.scheduled_start
        )
        .all()
    )

    return [
        meeting_out(meeting)
        for meeting in meetings
    ]


@app.get("/api/meetings/recent")
def recent(
    session: Session = Depends(db)
):

    meetings = (
        session
        .query(Meeting)
        .filter(
            Meeting.status.in_(["live", "ended"]),
            Meeting.host_id == DEFAULT_USER_ID,
        )
        .order_by(
            Meeting.started_at.desc()
        )
        .limit(10)
        .all()
    )

    return [
        meeting_out(meeting)
        for meeting in meetings
    ]


# ============================================================
# CREATE INSTANT MEETING
# ============================================================

@app.post("/api/meetings/instant")
def instant(
    body: InstantIn,
    session: Session = Depends(db)
):

    user = session.get(
        User,
        DEFAULT_USER_ID
    )

    if not user:
        raise HTTPException(
            status_code=404,
            detail="User not found"
        )

    meeting = Meeting(
        code=new_code(session),
        title=(
            body.title
            or f"{user.name}'s Meeting"
        ),
        host_id=user.id,
        kind="instant",
        status="live",
        scheduled_start=now(),
        started_at=now(),
    )

    session.add(meeting)
    session.commit()
    session.refresh(meeting)

    return meeting_out(meeting)


# ============================================================
# SCHEDULE MEETING
# ============================================================

@app.post("/api/meetings/schedule")
def schedule(
    body: ScheduleIn,
    session: Session = Depends(db)
):

    if not body.title.strip():
        raise HTTPException(
            status_code=422,
            detail="Title is required"
        )

    if not 5 <= body.duration_min <= 1440:
        raise HTTPException(
            status_code=422,
            detail="Duration must be between 5 and 1440 minutes"
        )

    start = body.start

    if start.tzinfo:
        start = (
            start
            .astimezone(timezone.utc)
            .replace(tzinfo=None)
        )

    meeting = Meeting(
        code=new_code(session),
        title=body.title.strip(),
        description=body.description,
        host_id=DEFAULT_USER_ID,
        kind="scheduled",
        status="scheduled",
        scheduled_start=start,
        duration_min=body.duration_min,
    )

    session.add(meeting)
    session.commit()
    session.refresh(meeting)

    return meeting_out(meeting)


# ============================================================
# LOOKUP MEETING
# ============================================================

@app.get("/api/meetings/lookup/find")
def lookup(
    q: str,
    session: Session = Depends(db)
):
    """
    Validate a meeting ID or full invite link.
    """

    return get_one(
        q,
        session
    )


@app.get("/api/meetings/{code}")
def get_one(
    code: str,
    session: Session = Depends(db)
):

    meeting = get_meeting(
        session,
        code
    )

    if meeting.status == "ended":
        raise HTTPException(
            status_code=410,
            detail="This meeting has ended."
        )

    return meeting_out(meeting)


# ============================================================
# JOIN MEETING
# ============================================================

@app.post("/api/meetings/{code}/join")
def join(
    code: str,
    body: JoinIn,
    session: Session = Depends(db)
):

    meeting = get_meeting(
        session,
        code
    )

    if meeting.status == "ended":
        raise HTTPException(
            status_code=410,
            detail="This meeting has ended."
        )

    name = body.display_name.strip()

    if not name:
        raise HTTPException(
            status_code=422,
            detail="Please enter your name"
        )

    is_host = (
        body.as_host
        and meeting.host_id == DEFAULT_USER_ID
    )

    participant = Participant(
        meeting_id=meeting.id,
        user_id=(
            DEFAULT_USER_ID
            if is_host
            else None
        ),
        display_name=name,
        is_host=is_host,
    )

    # First participant starts a scheduled meeting.
    if meeting.status == "scheduled":

        meeting.status = "live"
        meeting.started_at = now()

    session.add(participant)
    session.commit()
    session.refresh(participant)

    return {
        "participant": part_out(participant),
        "meeting": meeting_out(meeting),
    }


# ============================================================
# PARTICIPANTS
# ============================================================

@app.get("/api/meetings/{code}/participants")
def participants(
    code: str,
    session: Session = Depends(db)
):

    meeting = get_meeting(
        session,
        code
    )

    return {
        "status": meeting.status,
        "participants": [
            part_out(participant)
            for participant in meeting.participants
            if participant.status == "joined"
        ],
    }


# ============================================================
# MUTE ALL
# ============================================================

@app.post("/api/meetings/{code}/mute-all")
def mute_all(
    code: str,
    session: Session = Depends(db)
):

    meeting = get_meeting(
        session,
        code
    )

    for participant in meeting.participants:

        if (
            participant.status == "joined"
            and not participant.is_host
        ):
            participant.is_muted = True

    session.commit()

    return {
        "ok": True
    }


# ============================================================
# END MEETING
# ============================================================

@app.post("/api/meetings/{code}/end")
def end(
    code: str,
    session: Session = Depends(db)
):

    meeting = get_meeting(
        session,
        code
    )

    meeting.status = "ended"
    meeting.ended_at = now()

    for participant in meeting.participants:

        if participant.status == "joined":

            participant.status = "left"
            participant.left_at = now()

    session.commit()

    return {
        "ok": True
    }


# ============================================================
# PARTICIPANT MUTE
# ============================================================

@app.patch("/api/participants/{pid}")
def set_mute(
    pid: int,
    body: MuteIn,
    session: Session = Depends(db)
):

    participant = session.get(
        Participant,
        pid
    )

    if not participant:
        raise HTTPException(
            status_code=404,
            detail="Not found"
        )

    participant.is_muted = body.is_muted

    session.commit()

    return part_out(participant)


# ============================================================
# PARTICIPANT LEAVE
# ============================================================

@app.post("/api/participants/{pid}/leave")
def leave(
    pid: int,
    session: Session = Depends(db)
):

    participant = session.get(
        Participant,
        pid
    )

    if (
        participant
        and participant.status == "joined"
    ):
        participant.status = "left"
        participant.left_at = now()

        session.commit()

    return {
        "ok": True
    }


# ============================================================
# REMOVE PARTICIPANT
# ============================================================

@app.post("/api/participants/{pid}/remove")
def remove(
    pid: int,
    session: Session = Depends(db)
):

    participant = session.get(
        Participant,
        pid
    )

    if not participant:
        raise HTTPException(
            status_code=404,
            detail="Not found"
        )

    participant.status = "removed"
    participant.left_at = now()

    session.commit()

    return {
        "ok": True
    }