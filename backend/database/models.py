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
    stream_url = Column(Text, nullable=False)
    location   = Column(String(256))
    # Zone-based counting — each camera covers a distinct non-overlapping zone
    zone_name     = Column(String(128))   # e.g. "Main Floor", "Balcony", "Overflow"
    zone_capacity = Column(Integer, default=0)   # seat capacity for this zone
    zone_order    = Column(Integer, default=0)   # display order in venue summary
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


class ExclusionZone(Base):
    """
    A region in the camera frame where persons do NOT free seats.
    e.g. stage, front-rush area, choir area.
    """
    __tablename__ = "exclusion_zones"

    id                 = Column(Integer, primary_key=True, index=True)
    camera_id          = Column(Integer, ForeignKey("cameras.id"), nullable=False)
    zone_id            = Column(String(64), nullable=False)
    label              = Column(String(128), default="")
    # Controls actual behavior — NOT the label. "hold_seats" (stage/altar/
    # choir: hold overlapping seats while active) or "ignore" (exit/toilet/
    # walkway: purely informational, never affects seat state).
    zone_type          = Column(String(32), default="hold_seats", nullable=False)
    bbox               = Column(JSON, nullable=False)           # [x1, y1, x2, y2]
    hold_seats_in_rows = Column(JSON, default=list)             # ["A", "B", "C"]
    is_active          = Column(Boolean, default=True)
    created_at         = Column(DateTime, server_default=func.now())

    camera = relationship("Camera")


class RotaEntry(Base):
    """
    Scheduled stage appearance — seat hold policy.
    While start_time <= now <= end_time, affected seats stay ROTA_HOLD.
    """
    __tablename__ = "rota_entries"

    id          = Column(Integer, primary_key=True, index=True)
    camera_id   = Column(Integer, ForeignKey("cameras.id"), nullable=False)
    entry_id    = Column(String(64), nullable=False, index=True)
    label       = Column(String(128), nullable=False)         # e.g. "Choir", "Pastor John"
    start_time  = Column(DateTime, nullable=False)
    end_time    = Column(DateTime, nullable=False)
    seat_ids    = Column(JSON, default=list)                  # ["D7", "D8"]
    rows        = Column(JSON, default=list)                  # ["B", "C", "D"]
    section     = Column(String(128), nullable=True)
    is_active   = Column(Boolean, default=True)
    created_at  = Column(DateTime, server_default=func.now())

    camera = relationship("Camera")


class ReservedSeat(Base):
    """
    Permanently reserved seat — reserved sign, pastor's seat, VIP, etc.
    The AI will never mark this seat available.
    """
    __tablename__ = "reserved_seats"

    id           = Column(Integer, primary_key=True, index=True)
    camera_id    = Column(Integer, ForeignKey("cameras.id"), nullable=False)
    seat_id      = Column(String(64), nullable=False)           # e.g. "D7"
    reserved_for = Column(String(128), nullable=True)           # e.g. "Pastor John"
    note         = Column(Text, nullable=True)                  # e.g. "Reserved sign on chair"
    is_active    = Column(Boolean, default=True)
    created_at   = Column(DateTime, server_default=func.now())

    camera = relationship("Camera")


class AnalyticsSummary(Base):
    """
    Persistent spatial memory for the MovementClassifier.

    Each confirmed answer to a review request is stored here.
    When confirmation_count reaches the threshold, the system
    auto-creates an ExclusionZone and stops asking questions
    about that region — permanently.

    Survives worker restarts and new services.
    """
    __tablename__ = "spatial_memory"

    id                 = Column(Integer, primary_key=True, index=True)
    camera_id          = Column(Integer, ForeignKey("cameras.id"), nullable=False)
    region_key         = Column(String(32), nullable=False)    # "cx_grid:cy_grid"
    region_cx          = Column(Float, nullable=False)         # grid cell centre x
    region_cy          = Column(Float, nullable=False)         # grid cell centre y
    classification     = Column(String(32), nullable=False)    # "stage_move" | "exit" etc.
    confirmation_count = Column(Integer, default=1)
    auto_zone_created  = Column(Boolean, default=False)        # True once zone was created
    created_at         = Column(DateTime, server_default=func.now())
    updated_at         = Column(DateTime, server_default=func.now(), onupdate=func.now())

    camera = relationship("Camera")

# Alias — imported as SpatialMemory throughout the codebase
SpatialMemory = AnalyticsSummary


class User(Base):
    """Dashboard users — supports multiple admins/operators."""
    __tablename__ = "users"

    id              = Column(Integer, primary_key=True, index=True)
    username        = Column(String(64), unique=True, nullable=False, index=True)
    display_name    = Column(String(128))
    hashed_password = Column(String(256), nullable=False)
    role            = Column(String(32), default="operator")   # admin | operator | viewer
    is_active       = Column(Boolean, default=True)
    created_at      = Column(DateTime, server_default=func.now())
    updated_at      = Column(DateTime, server_default=func.now(), onupdate=func.now())


class AnalyticsSummaryDaily(Base):
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
