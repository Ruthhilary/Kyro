"""
Kyro — Attendance API Routes

GET  /api/v1/attendance/live/{camera_id}     — Current live metrics
GET  /api/v1/attendance/sessions             — List sessions
GET  /api/v1/attendance/sessions/{id}        — Session detail
POST /api/v1/attendance/sessions             — Start a new session
PUT  /api/v1/attendance/sessions/{id}/end    — End a session
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.database.connection import get_db
from backend.database.models import Session as DBSession, AttendanceEvent
from backend.services.pipeline_registry import pipeline_registry

router = APIRouter(prefix="/api/v1/attendance", tags=["Attendance"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SessionCreate(BaseModel):
    camera_id: str
    name: str
    venue_capacity: int = 0


class SessionResponse(BaseModel):
    session_id: str
    camera_id: str
    name: str
    started_at: datetime
    ended_at: Optional[datetime]
    venue_capacity: int
    peak_attendance: int
    total_entries: int
    total_exits: int


class LiveMetrics(BaseModel):
    camera_id: str
    current_attendance: int
    peak_attendance: int
    total_entries: int
    total_exits: int
    occupancy_percent: float
    timestamp: float


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/live/{camera_id}", response_model=LiveMetrics)
async def get_live_metrics(camera_id: str):
    """Return the latest attendance metrics for a camera feed."""
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(status_code=404, detail=f"Camera '{camera_id}' not found or not running")

    snapshot = pipeline._counter.snapshot()
    return LiveMetrics(
        camera_id=camera_id,
        current_attendance=snapshot.current_attendance,
        peak_attendance=snapshot.peak_attendance,
        total_entries=snapshot.total_entries,
        total_exits=snapshot.total_exits,
        occupancy_percent=snapshot.occupancy_percent,
        timestamp=snapshot.timestamp,
    )


@router.get("/sessions", response_model=list[SessionResponse])
async def list_sessions(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(DBSession).order_by(DBSession.started_at.desc()).limit(50)
    )
    sessions = result.scalars().all()
    return [
        SessionResponse(
            session_id=s.session_id,
            camera_id=str(s.camera_id),
            name=s.name or "",
            started_at=s.started_at,
            ended_at=s.ended_at,
            venue_capacity=s.venue_capacity,
            peak_attendance=s.peak_attendance,
            total_entries=s.total_entries,
            total_exits=s.total_exits,
        )
        for s in sessions
    ]
