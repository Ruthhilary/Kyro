"""
Kyro — Database Models (SQLAlchemy)

Tables:
- cameras:           Registered camera feeds
- sessions:          Service sessions (each church service = one session)
- attendance_events: Per-frame attendance snapshots
- seat_layouts:      Saved seat configurations per camera
- analytics:         Aggregated daily/weekly stats
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class Camera(Base):
    __tablename__ = "cameras"

    id         = Column(Integer, primary_key=True, index=True)
    camera_id  = Column(String(64), unique=True, nullable=False, index=True)
    name       = Column(String(128), nullable=False)
    stream_url = Column(Text, nullable=False)   # RTSP / MJPEG / device index
    location   = Column(String(256))            # e.g. "Main Auditorium - Left"
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    sessions      = relationship("Session", back_populates="camera")
    seat_layouts  = relationship("SeatLayout", back_populates="camera")


class Session(Base):
    """One church service / attendance session."""
    __tablename__ = "sessions"

    id                = Column(Integer, primary_key=True, index=True)
    session_id        = Column(String(64), unique=True, nullable=False, index=True)
    camera_id         = Column(Integer, ForeignKey("cameras.id"), nullable=False)
    name              = Column(String(128))          # e.g. "Sunday Morning Service"
    started_at        = Column(DateTime, nullable=False)
    ended_at          = Column(DateTime, nullable=True)
    venue_capacity    = Column(Integer, default=0)
    peak_attendance   = Column(Integer, default=0)
    total_entries     = Column(Integer, default=0)
    total_exits       = Column(Integer, default=0)
    created_at        = Column(DateTime, server_default=func.now())

    camera            = relationship("Camera", back_populates="sessions")
    attendance_events = relationship("AttendanceEvent", back_populates="session")


class AttendanceEvent(Base):
    """Periodic attendance snapshot (flushed every N seconds)."""
    __tablename__ = "attendance_events"

    id                  = Column(Integer, primary_key=True, index=True)
    session_id          = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    recorded_at         = Column(DateTime, nullable=False)
    current_attendance  = Column(Integer, nullable=False)
    total_entries       = Column(Integer, nullable=False)
    total_exits         = Column(Integer, nullable=False)
    occupancy_percent   = Column(Float, nullable=False)
    seat_occupancy_json = Column(JSON)   # full seat state snapshot

    session = relationship("Session", back_populates="attendance_events")


class SeatLayout(Base):
    """Saved seat layout for a camera view."""
    __tablename__ = "seat_layouts"

    id          = Column(Integer, primary_key=True, index=True)
    camera_id   = Column(Integer, ForeignKey("cameras.id"), nullable=False)
    name        = Column(String(128), nullable=False)
    seats_json  = Column(JSON, nullable=False)   # list of seat definitions
    is_active   = Column(Boolean, default=True)
    created_at  = Column(DateTime, server_default=func.now())

    camera = relationship("Camera", back_populates="seat_layouts")


class AnalyticsSummary(Base):
    """Daily aggregated analytics."""
    __tablename__ = "analytics_summaries"

    id                  = Column(Integer, primary_key=True, index=True)
    date                = Column(DateTime, nullable=False, index=True)
    camera_id           = Column(Integer, ForeignKey("cameras.id"), nullable=False)
    avg_attendance      = Column(Float, default=0.0)
    peak_attendance     = Column(Integer, default=0)
    total_sessions      = Column(Integer, default=0)
    avg_occupancy_pct   = Column(Float, default=0.0)
    heatmap_json        = Column(JSON)   # grid of presence density
    arrival_pattern     = Column(JSON)   # hour → count
    departure_pattern   = Column(JSON)   # hour → count
    created_at          = Column(DateTime, server_default=func.now())
