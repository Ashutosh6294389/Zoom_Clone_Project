"""Zoom clone API - FastAPI + SQLAlchemy + SQLite."""
import random
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker

import os

DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True
)
SessionLocal = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()
now = lambda: datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC


# ---------- Schema ----------
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    email = Column(String(120), unique=True, nullable=False)
    meetings = relationship("Meeting", back_populates="host")


class Meeting(Base):
    __tablename__ = "meetings"
    id = Column(Integer, primary_key=True)
    code = Column(String(10), unique=True, index=True, nullable=False)  # 10-digit meeting ID
    title = Column(String(200), nullable=False)
    description = Column(Text, default="")
    host_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    kind = Column(String(10), default="scheduled")  # instant | scheduled
    status = Column(String(10), default="scheduled")  # scheduled | live | ended
    scheduled_start = Column(DateTime, nullable=False)
    duration_min = Column(Integer, default=30)
    started_at = Column(DateTime)
    ended_at = Column(DateTime)
    created_at = Column(DateTime, default=now)
    host = relationship("User", back_populates="meetings")
    participants = relationship("Participant", back_populates="meeting", cascade="all, delete-orphan")


class Participant(Base):
    __tablename__ = "participants"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))  # null for guests
    display_name = Column(String(100), nullable=False)
    is_host = Column(Boolean, default=False)
    is_muted = Column(Boolean, default=False)
    status = Column(String(10), default="joined")  # joined | left | removed
    joined_at = Column(DateTime, default=now)
    left_at = Column(DateTime)
    meeting = relationship("Meeting", back_populates="participants")


Base.metadata.create_all(engine)


# ---------- Helpers ----------
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


iso = lambda d: d.isoformat() + "Z" if d else None


def normalize_code(raw: str) -> str:
    raw = raw.strip()
    if "/meeting/" in raw:  # invite link
        raw = raw.split("/meeting/")[1].split("?")[0]
    return re.sub(r"\D", "", raw)


def new_code(s: Session) -> str:
    while True:
        c = str(random.randint(10**9, 10**10 - 1))
        if not s.query(Meeting).filter_by(code=c).first():
            return c


def meeting_out(m: Meeting):
    return dict(id=m.id, code=m.code, title=m.title, description=m.description, host=m.host.name,
                kind=m.kind, status=m.status, scheduled_start=iso(m.scheduled_start),
                duration_min=m.duration_min, started_at=iso(m.started_at), ended_at=iso(m.ended_at),
                participant_count=sum(1 for p in m.participants if p.status == "joined"))


def part_out(p: Participant):
    return dict(id=p.id, display_name=p.display_name, is_host=p.is_host, is_muted=p.is_muted, status=p.status)


def get_meeting(s: Session, code: str) -> Meeting:
    m = s.query(Meeting).filter_by(code=normalize_code(code)).first()
    if not m:
        raise HTTPException(404, "Invalid meeting ID. Please check and try again.")
    return m


def seed():
    s = SessionLocal()
    if s.query(User).count():
        return
    me = User(name="Demo User", email="demo@zoomclone.dev")
    s.add(me); s.flush()
    t = now().replace(minute=0, second=0, microsecond=0)
    rows = [
        ("Weekly Team Sync", "Status updates and blockers", 1, 60, "scheduled"),
        ("Design Review", "Review the new dashboard mockups", 26, 45, "scheduled"),
        ("Sprint Planning", "Plan next sprint's backlog", 50, 90, "scheduled"),
        ("Client Onboarding Call", "Kickoff with new client", 75, 30, "scheduled"),
        ("1:1 with Manager", "Career growth discussion", -24, 30, "ended"),
        ("Product Demo", "Quarterly product demo", -48, 60, "ended"),
        ("Interview: Frontend Engineer", "Technical round", -72, 45, "ended"),
    ]
    for title, desc, off, dur, status in rows:
        start = t + timedelta(hours=off)
        m = Meeting(code=new_code(s), title=title, description=desc, host_id=me.id, kind="scheduled",
                    status=status, scheduled_start=start, duration_min=dur)
        if status == "ended":
            m.started_at, m.ended_at = start, start + timedelta(minutes=dur)
        s.add(m); s.flush()
        if status == "ended":
            for n, host in [("Demo User", True), ("Priya Sharma", False), ("Rahul Verma", False)]:
                s.add(Participant(meeting_id=m.id, display_name=n, is_host=host, status="left", joined_at=start))
    s.commit(); s.close()


seed()
app = FastAPI(title="Zoom Clone API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
DEFAULT_USER_ID = 1  # no auth: assume the seeded user is logged in


# WebRTC peers exchange offers, answers, and ICE candidates through this small
# signaling hub. Media itself travels directly between browsers.
class SignalingHub:
    def __init__(self):
        self.rooms: dict[str, dict[str, WebSocket]] = {}

    async def connect(self, meeting_code: str, participant_id: str, websocket: WebSocket):
        await websocket.accept()
        room = self.rooms.setdefault(meeting_code, {})
        peers = list(room)
        room[participant_id] = websocket
        await websocket.send_json({"type": "peers", "peers": peers})

    async def disconnect(self, meeting_code: str, participant_id: str):
        room = self.rooms.get(meeting_code)
        if not room:
            return
        room.pop(participant_id, None)
        if not room:
            self.rooms.pop(meeting_code, None)
            return
        for peer in list(room.values()):
            try:
                await peer.send_json({"type": "participant-left", "participantId": participant_id})
            except RuntimeError:
                pass

    async def relay(self, meeting_code: str, sender_id: str, target_id: str, signal: dict):
        peer = self.rooms.get(meeting_code, {}).get(target_id)
        if peer:
            await peer.send_json({"type": "signal", "participantId": sender_id, "signal": signal})


signaling = SignalingHub()


# ---------- Schemas ----------
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


@app.websocket("/ws/meetings/{code}/participants/{participant_id}")
async def signal_meeting(code: str, participant_id: int, websocket: WebSocket):
    session = SessionLocal()
    try:
        participant = session.get(Participant, participant_id)
        meeting = session.get(Meeting, participant.meeting_id) if participant else None
        is_valid = bool(participant and meeting and meeting.code == normalize_code(code) and participant.status == "joined")
    finally:
        session.close()

    if not is_valid:
        await websocket.close(code=1008)
        return

    participant_key = str(participant_id)
    await signaling.connect(normalize_code(code), participant_key, websocket)
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "signal" and isinstance(message.get("signal"), dict):
                await signaling.relay(normalize_code(code), participant_key, str(message.get("to", "")), message["signal"])
    except WebSocketDisconnect:
        pass
    finally:
        await signaling.disconnect(normalize_code(code), participant_key)


# ---------- Routes ----------
@app.get("/api/me")
def me(s: Session = Depends(db)):
    u = s.get(User, DEFAULT_USER_ID)
    return dict(id=u.id, name=u.name, email=u.email)


@app.get("/api/meetings/upcoming")
def upcoming(s: Session = Depends(db)):
    q = s.query(Meeting).filter(Meeting.status == "scheduled", Meeting.host_id == DEFAULT_USER_ID,
                                Meeting.scheduled_start >= now() - timedelta(hours=1))
    return [meeting_out(m) for m in q.order_by(Meeting.scheduled_start).all()]


@app.get("/api/meetings/recent")
def recent(s: Session = Depends(db)):
    q = s.query(Meeting).filter(Meeting.status.in_(["live", "ended"]), Meeting.host_id == DEFAULT_USER_ID)
    return [meeting_out(m) for m in q.order_by(Meeting.started_at.desc()).limit(10).all()]


@app.post("/api/meetings/instant")
def instant(body: InstantIn, s: Session = Depends(db)):
    u = s.get(User, DEFAULT_USER_ID)
    m = Meeting(code=new_code(s), title=body.title or f"{u.name}'s Meeting", host_id=u.id, kind="instant",
                status="live", scheduled_start=now(), started_at=now())
    s.add(m); s.commit(); s.refresh(m)
    return meeting_out(m)


@app.post("/api/meetings/schedule")
def schedule(body: ScheduleIn, s: Session = Depends(db)):
    if not body.title.strip():
        raise HTTPException(422, "Title is required")
    if not 5 <= body.duration_min <= 1440:
        raise HTTPException(422, "Duration must be between 5 and 1440 minutes")
    start = body.start
    if start.tzinfo:
        start = start.astimezone(timezone.utc).replace(tzinfo=None)
    m = Meeting(code=new_code(s), title=body.title.strip(), description=body.description,
                host_id=DEFAULT_USER_ID, kind="scheduled", status="scheduled",
                scheduled_start=start, duration_min=body.duration_min)
    s.add(m); s.commit(); s.refresh(m)
    return meeting_out(m)


@app.get("/api/meetings/lookup/find")
def lookup(q: str, s: Session = Depends(db)):
    """Validate a meeting ID or a full invite link (links contain slashes, so use a query param)."""
    return get_one(q, s)


@app.get("/api/meetings/{code}")
def get_one(code: str, s: Session = Depends(db)):
    m = get_meeting(s, code)
    if m.status == "ended":
        raise HTTPException(410, "This meeting has ended.")
    return meeting_out(m)


@app.post("/api/meetings/{code}/join")
def join(code: str, body: JoinIn, s: Session = Depends(db)):
    m = get_meeting(s, code)
    if m.status == "ended":
        raise HTTPException(410, "This meeting has ended.")
    name = body.display_name.strip()
    if not name:
        raise HTTPException(422, "Please enter your name")
    is_host = body.as_host and m.host_id == DEFAULT_USER_ID
    p = Participant(meeting_id=m.id, user_id=DEFAULT_USER_ID if is_host else None, display_name=name, is_host=is_host)
    if m.status == "scheduled":
        m.status, m.started_at = "live", now()
    s.add(p); s.commit(); s.refresh(p)
    return dict(participant=part_out(p), meeting=meeting_out(m))


@app.get("/api/meetings/{code}/participants")
def participants(code: str, s: Session = Depends(db)):
    m = get_meeting(s, code)
    return dict(status=m.status, participants=[part_out(p) for p in m.participants if p.status == "joined"])


@app.post("/api/meetings/{code}/mute-all")
def mute_all(code: str, s: Session = Depends(db)):
    m = get_meeting(s, code)
    for p in m.participants:
        if p.status == "joined" and not p.is_host:
            p.is_muted = True
    s.commit()
    return {"ok": True}


@app.post("/api/meetings/{code}/end")
def end(code: str, s: Session = Depends(db)):
    m = get_meeting(s, code)
    m.status, m.ended_at = "ended", now()
    for p in m.participants:
        if p.status == "joined":
            p.status, p.left_at = "left", now()
    s.commit()
    return {"ok": True}


@app.patch("/api/participants/{pid}")
def set_mute(pid: int, body: MuteIn, s: Session = Depends(db)):
    p = s.get(Participant, pid) or HTTPException(404, "Not found")
    if isinstance(p, HTTPException):
        raise p
    p.is_muted = body.is_muted
    s.commit()
    return part_out(p)


@app.post("/api/participants/{pid}/leave")
def leave(pid: int, s: Session = Depends(db)):
    p = s.get(Participant, pid)
    if p and p.status == "joined":
        p.status, p.left_at = "left", now()
        s.commit()
    return {"ok": True}


@app.post("/api/participants/{pid}/remove")
def remove(pid: int, s: Session = Depends(db)):
    p = s.get(Participant, pid)
    if not p:
        raise HTTPException(404, "Not found")
    p.status, p.left_at = "removed", now()
    s.commit()
    return {"ok": True}
