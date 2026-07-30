"""
Kyro — Analytics Routes

GET /api/v1/analytics/{camera_id}/history         — Attendance over time (paginated)
GET /api/v1/analytics/{camera_id}/weekly          — Weekly attendance totals
GET /api/v1/analytics/{camera_id}/heatmap         — Seat utilisation heatmap
GET /api/v1/analytics/{camera_id}/arrival         — Arrival pattern (hour buckets)
GET /api/v1/analytics/{camera_id}/departure       — Departure pattern (hour buckets)
GET /api/v1/analytics/{camera_id}/summary         — All-time summary stats
POST /api/v1/analytics/{camera_id}/flush          — Force-flush current session to DB
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt
from backend.database.connection import get_db
from backend.database.models import AttendanceEvent, Camera, Session as DBSession, AnalyticsSummary
from backend.services.pipeline_registry import pipeline_registry

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/analytics", tags=["Analytics"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AttendancePoint(BaseModel):
    timestamp: datetime
    attendance: int
    occupancy_pct: float


class WeeklyBucket(BaseModel):
    week_start: datetime
    avg_attendance: float
    peak_attendance: int
    total_sessions: int


class HeatmapResponse(BaseModel):
    camera_id: str
    grid: list[list[float]]   # rows × cols, each cell = utilisation 0.0–1.0
    rows: int
    cols: int


class HourlyBucket(BaseModel):
    hour: int           # 0–23
    count: int
    avg_count: float


class AnalyticsSummaryResponse(BaseModel):
    camera_id: str
    total_sessions: int
    all_time_peak: int
    avg_attendance: float
    avg_occupancy_pct: float
    first_session: Optional[datetime]
    last_session: Optional[datetime]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/{camera_id}/history", response_model=list[AttendancePoint])
async def attendance_history(
    camera_id: str,
    days: int = Query(default=7, ge=1, le=90, description="Number of days to look back"),
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """Time-series attendance data for charts."""
    cam = await _require_camera(camera_id, db)
    since = datetime.now(timezone.utc) - timedelta(days=days)

    result = await db.execute(
        select(AttendanceEvent)
        .join(DBSession, AttendanceEvent.session_id == DBSession.id)
        .where(
            DBSession.camera_id == cam.id,
            AttendanceEvent.recorded_at >= since,
        )
        .order_by(AttendanceEvent.recorded_at.asc())
        .limit(2000)
    )
    events = result.scalars().all()
    return [
        AttendancePoint(
            timestamp=e.recorded_at,
            attendance=e.current_attendance,
            occupancy_pct=e.occupancy_percent,
        )
        for e in events
    ]


@router.get("/{camera_id}/weekly", response_model=list[WeeklyBucket])
async def weekly_trends(
    camera_id: str,
    weeks: int = Query(default=12, ge=1, le=52),
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """Weekly aggregated attendance buckets."""
    cam = await _require_camera(camera_id, db)
    since = datetime.now(timezone.utc) - timedelta(weeks=weeks)

    result = await db.execute(
        select(DBSession)
        .where(
            DBSession.camera_id == cam.id,
            DBSession.started_at >= since,
            DBSession.ended_at != None,
        )
        .order_by(DBSession.started_at.asc())
    )
    sessions = result.scalars().all()

    # Group into ISO week buckets
    week_map: dict[datetime, list] = defaultdict(list)
    for s in sessions:
        # ISO week Monday as key
        start = s.started_at
        week_monday = start - timedelta(days=start.weekday())
        week_monday = week_monday.replace(hour=0, minute=0, second=0, microsecond=0)
        week_map[week_monday].append(s)

    buckets: list[WeeklyBucket] = []
    for week_start in sorted(week_map):
        week_sessions = week_map[week_start]
        peaks = [s.peak_attendance for s in week_sessions]
        buckets.append(WeeklyBucket(
            week_start=week_start,
            avg_attendance=round(sum(peaks) / len(peaks), 1),
            peak_attendance=max(peaks),
            total_sessions=len(week_sessions),
        ))

    return buckets


@router.get("/{camera_id}/heatmap", response_model=HeatmapResponse)
async def seat_heatmap(
    camera_id: str,
    days: int = Query(default=30, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """
    Returns a utilisation heatmap aggregated from stored seat_occupancy_json snapshots.
    Each cell is the fraction of snapshots in which that seat was occupied (0.0–1.0).
    """
    cam = await _require_camera(camera_id, db)
    since = datetime.now(timezone.utc) - timedelta(days=days)

    result = await db.execute(
        select(AttendanceEvent.seat_occupancy_json)
        .join(DBSession, AttendanceEvent.session_id == DBSession.id)
        .where(
            DBSession.camera_id == cam.id,
            AttendanceEvent.recorded_at >= since,
            AttendanceEvent.seat_occupancy_json != None,
        )
        .limit(500)  # cap for performance
    )
    snapshots = [row[0] for row in result.all() if row[0]]

    if not snapshots:
        return HeatmapResponse(camera_id=camera_id, grid=[], rows=0, cols=0)

    # Aggregate seat utilisation across snapshots
    seat_hits: dict[str, int] = defaultdict(int)
    total = len(snapshots)
    for snap in snapshots:
        for seat in snap:
            if seat.get("state") == "occupied":
                seat_hits[seat["seat_id"]] += 1

    # Build utilisation per seat
    seat_util = {sid: hits / total for sid, hits in seat_hits.items()}

    # Layout seats in a grid (use first snapshot for seat order)
    all_seat_ids = [s["seat_id"] for s in snapshots[0]]
    n = len(all_seat_ids)
    if n == 0:
        return HeatmapResponse(camera_id=camera_id, grid=[], rows=0, cols=0)

    # Auto grid: square-ish layout
    cols = max(1, int(n ** 0.5))
    rows = (n + cols - 1) // cols

    grid: list[list[float]] = []
    for r in range(rows):
        row_data: list[float] = []
        for c in range(cols):
            idx = r * cols + c
            if idx < n:
                row_data.append(round(seat_util.get(all_seat_ids[idx], 0.0), 3))
            else:
                row_data.append(0.0)
        grid.append(row_data)

    return HeatmapResponse(camera_id=camera_id, grid=grid, rows=rows, cols=cols)


@router.get("/{camera_id}/arrival", response_model=list[HourlyBucket])
async def arrival_pattern(
    camera_id: str,
    days: int = Query(default=30, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """Histogram of when people arrive (by hour of day)."""
    return await _hourly_pattern(camera_id, days, "arrival", db)


@router.get("/{camera_id}/departure", response_model=list[HourlyBucket])
async def departure_pattern(
    camera_id: str,
    days: int = Query(default=30, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """Histogram of when people leave (by hour of day)."""
    return await _hourly_pattern(camera_id, days, "departure", db)


@router.get("/{camera_id}/summary", response_model=AnalyticsSummaryResponse)
async def analytics_summary(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """All-time aggregate stats for a camera."""
    cam = await _require_camera(camera_id, db)

    result = await db.execute(
        select(DBSession).where(
            DBSession.camera_id == cam.id,
            DBSession.ended_at != None,
        )
    )
    sessions = result.scalars().all()

    if not sessions:
        return AnalyticsSummaryResponse(
            camera_id=camera_id,
            total_sessions=0,
            all_time_peak=0,
            avg_attendance=0.0,
            avg_occupancy_pct=0.0,
            first_session=None,
            last_session=None,
        )

    peaks = [s.peak_attendance for s in sessions]
    started_dates = [s.started_at for s in sessions]

    return AnalyticsSummaryResponse(
        camera_id=camera_id,
        total_sessions=len(sessions),
        all_time_peak=max(peaks),
        avg_attendance=round(sum(peaks) / len(peaks), 1),
        avg_occupancy_pct=0.0,  # computed from AttendanceEvents — extend if needed
        first_session=min(started_dates),
        last_session=max(started_dates),
    )


@router.post("/{camera_id}/flush", status_code=200)
async def flush_session(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """
    Force-write the current pipeline snapshot into the AttendanceEvent table.
    Useful for end-of-service saves without waiting for the background flusher.
    """
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(404, f"Camera '{camera_id}' pipeline not running")

    cam = await _require_camera(camera_id, db)

    # Find the most recent open session for this camera
    result = await db.execute(
        select(DBSession).where(
            DBSession.camera_id == cam.id,
            DBSession.ended_at == None,
        ).order_by(DBSession.started_at.desc()).limit(1)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(400, "No active session found for this camera")

    snapshot = pipeline._counter.snapshot()
    seat_states = [s.to_dict() for s in pipeline._seat_engine.seats]

    event = AttendanceEvent(
        session_id=session.id,
        recorded_at=datetime.now(timezone.utc),
        current_attendance=snapshot.current_attendance,
        total_entries=snapshot.total_entries,
        total_exits=snapshot.total_exits,
        occupancy_percent=snapshot.occupancy_percent,
        seat_occupancy_json=seat_states,
    )
    db.add(event)

    # Update session peak
    if snapshot.peak_attendance > session.peak_attendance:
        session.peak_attendance = snapshot.peak_attendance
    session.total_entries = snapshot.total_entries
    session.total_exits = snapshot.total_exits

    await db.commit()
    return {"flushed": True, "attendance": snapshot.current_attendance}


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

async def _require_camera(camera_id: str, db: AsyncSession) -> Camera:
    result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, f"Camera '{camera_id}' not found")
    return cam


async def _hourly_pattern(
    camera_id: str,
    days: int,
    kind: str,  # "arrival" | "departure"
    db: AsyncSession,
) -> list[HourlyBucket]:
    cam = await _require_camera(camera_id, db)
    since = datetime.now(timezone.utc) - timedelta(days=days)

    # We approximate arrival/departure patterns from AttendanceEvent deltas
    result = await db.execute(
        select(AttendanceEvent)
        .join(DBSession, AttendanceEvent.session_id == DBSession.id)
        .where(
            DBSession.camera_id == cam.id,
            AttendanceEvent.recorded_at >= since,
        )
        .order_by(AttendanceEvent.recorded_at.asc())
    )
    events = result.scalars().all()

    hour_counts: dict[int, list[int]] = defaultdict(list)
    prev_entries = prev_exits = 0

    for e in events:
        hour = e.recorded_at.hour
        if kind == "arrival":
            delta = max(0, e.total_entries - prev_entries)
            prev_entries = e.total_entries
        else:
            delta = max(0, e.total_exits - prev_exits)
            prev_exits = e.total_exits
        hour_counts[hour].append(delta)

    buckets: list[HourlyBucket] = []
    for h in range(24):
        vals = hour_counts.get(h, [0])
        buckets.append(HourlyBucket(
            hour=h,
            count=sum(vals),
            avg_count=round(sum(vals) / max(len(vals), 1), 1),
        ))
    return buckets
