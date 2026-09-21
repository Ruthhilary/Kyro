"""
Kyro — Attendance API Routes

GET  /api/v1/attendance/live/{camera_id}     — Current live metrics
GET  /api/v1/attendance/sessions             — List sessions
GET  /api/v1/attendance/sessions/{id}        — Session detail
POST /api/v1/attendance/sessions             — Start a new session
PUT  /api/v1/attendance/sessions/{id}/end    — End a session
GET  /api/v1/attendance/sessions/{id}/export — Export session as CSV
GET  /api/v1/attendance/alerts/{camera_id}   — Active capacity alerts for one camera
GET  /api/v1/attendance/alerts               — Active capacity alerts across all cameras
"""

from __future__ import annotations

import csv
import io
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)
from sqlalchemy import select

from backend.auth.dependencies import require_jwt, require_admin_or_operator
from backend.database.connection import get_db
from backend.database.models import Camera, Session as DBSession, AttendanceEvent
from backend.services.pipeline_registry import pipeline_registry

router = APIRouter(prefix="/api/v1/attendance", tags=["Attendance"])

# Camera online/offline transition state used to live here as a module-level
# dict. It now lives in backend.services.alert_store (Redis-backed) so that it
# is shared across uvicorn workers and survives restarts — a per-process dict
# meant recovery events were lost whenever a different worker served the poll.


def _utcnow() -> datetime:
    """Naive UTC timestamp — matches the DB's TIMESTAMP WITHOUT TIME ZONE columns.

    Using a tz-aware datetime here causes asyncpg to raise
    'can't subtract offset-naive and offset-aware datetimes'.
    """
    return datetime.utcnow()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SessionCreate(BaseModel):
    camera_id: str
    name: str
    venue_capacity: int = 0


class SessionUpdate(BaseModel):
    name: str


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


class AlertResponse(BaseModel):
    camera_id: str
    alert: bool
    message: str
    current_attendance: int
    venue_capacity: int
    occupancy_percent: float


class AlertItem(BaseModel):
    camera_id: str
    zone_name: str
    level: str          # "critical" | "warning" | "offline" | "online"
    message: str        # short title, e.g. "Camera Back Online"
    detail: str = ""    # supporting line, e.g. "Feed restored after 4m"
    current_attendance: int
    venue_capacity: int
    occupancy_percent: float
    triggered_at: str
    resolved: bool = False


# ---------------------------------------------------------------------------
# Live metrics
# ---------------------------------------------------------------------------

@router.get("/live/{camera_id}", response_model=LiveMetrics)
async def get_live_metrics(camera_id: str, _: dict = Depends(require_admin_or_operator)):
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


# ---------------------------------------------------------------------------
# Alerts — capacity threshold
# ---------------------------------------------------------------------------

@router.get("/alerts/{camera_id}", response_model=AlertResponse)
async def get_capacity_alert(
    camera_id: str,
    threshold: float = Query(default=0.9, ge=0.0, le=1.0, description="Alert threshold 0.0–1.0"),
    _: dict = Depends(require_admin_or_operator),
):
    """
    Returns an alert if current occupancy exceeds the threshold.
    threshold=0.9 means alert when >= 90% full.
    """
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(404, f"Camera '{camera_id}' pipeline not running")

    snapshot = pipeline._counter.snapshot()
    capacity = pipeline._counter._venue_capacity
    pct = snapshot.occupancy_percent

    triggered = capacity > 0 and (snapshot.current_attendance / capacity) >= threshold

    message = (
        f"⚠️  Capacity alert: {snapshot.current_attendance}/{capacity} seats filled ({pct:.1f}%)"
        if triggered
        else f"Attendance normal: {snapshot.current_attendance} present"
    )

    return AlertResponse(
        camera_id=camera_id,
        alert=triggered,
        message=message,
        current_attendance=snapshot.current_attendance,
        venue_capacity=capacity,
        occupancy_percent=pct,
    )


@router.get("/alerts", response_model=list[AlertItem])
async def get_all_alerts(
    limit: int = Query(default=20, ge=1, le=100),
    max_age_hours: int = Query(default=24, ge=1, le=168),
    include_resolved: bool = Query(default=True, description="Include alerts that have since cleared"),
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """
    Returns the recent alert *feed* — a timeline of things that happened,
    newest first.

    This reads from the shared alert_store rather than re-deriving state on
    every request. That distinction is the fix for three bugs at once:

      - Timestamps are now when the event actually fired, not when you polled.
        Three cameras that dropped at different times no longer all claim the
        same minute.
      - Recoveries appear. "Camera Back Online" is a transition, which a
        stateless snapshot can't express — it needs memory of the previous
        state, which now lives in Redis and is shared by all workers.
      - Offline no longer floods the list. A camera that went down once
        produces one entry, which gets marked resolved when it recovers,
        instead of a fresh identical row on every 30-second poll.

    An unresolved offline event is still re-surfaced as an ongoing state below,
    so a camera that's been down for hours doesn't silently scroll away.
    """
    from backend.services import alert_store

    events = alert_store.get_events(
        limit=limit,
        max_age_hours=max_age_hours,
        include_resolved=include_resolved,
    )

    # Map camera_id → zone_name for any event whose camera has since been
    # renamed, so the feed shows current names rather than stale ones.
    cam_result = await db.execute(select(Camera).where(Camera.is_active == True))
    cameras = cam_result.scalars().all()
    zone_map = {c.camera_id: (c.zone_name or c.name) for c in cameras}

    items: list[AlertItem] = []
    for ev in events:
        cid = ev.get("camera_id", "")
        items.append(AlertItem(
            camera_id=cid,
            zone_name=zone_map.get(cid, ev.get("zone_name") or cid),
            level=ev.get("level", "warning"),
            message=ev.get("title") or ev.get("message") or "Alert",
            detail=ev.get("message", ""),
            current_attendance=ev.get("current_attendance", 0),
            venue_capacity=ev.get("venue_capacity", 0),
            occupancy_percent=ev.get("occupancy_percent", 0.0),
            triggered_at=ev.get("triggered_at", ""),
            resolved=bool(ev.get("resolved")),
        ))

    # Ongoing offline states that produced no recent event — e.g. a camera
    # that has been down since before the retention window, or that went down
    # while the watcher was restarting. Without this a long outage would
    # eventually vanish from the panel entirely, which is the opposite of what
    # you want from a camera that is still down.
    seen_offline = {i.camera_id for i in items if i.level == "offline" and not i.resolved}
    for cam in cameras:
        state = alert_store.get_camera_state(cam.camera_id)
        if not state or state.get("status") != "offline":
            continue
        if cam.camera_id in seen_offline:
            continue
        items.append(AlertItem(
            camera_id=cam.camera_id,
            zone_name=cam.zone_name or cam.name,
            level="offline",
            message="Camera Offline",
            detail="Still offline — no heartbeat received.",
            current_attendance=0,
            venue_capacity=cam.zone_capacity or 0,
            occupancy_percent=0.0,
            triggered_at=state.get("since", ""),
            resolved=False,
        ))

    # Newest first, but unresolved criticals always float to the top — an
    # overcrowding alert from 5 minutes ago matters more than a routine
    # recovery from 30 seconds ago.
    items.sort(key=lambda a: a.triggered_at or "", reverse=True)   # newest first
    items.sort(key=lambda a: 0 if (a.level == "critical" and not a.resolved) else 1)
    return items[:limit]


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

@router.get("/sessions", response_model=list[SessionResponse])
async def list_sessions(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    result = await db.execute(
        select(DBSession).order_by(DBSession.started_at.desc()).limit(50)
    )
    sessions = result.scalars().all()

    # Resolve each session's real string camera_id (e.g. "cam-01") in one
    # batch query — without this, _session_to_response() falls back to
    # str(session.camera_id), which is the internal DB integer foreign
    # key, not the external identifier the frontend matches against. That
    # mismatch meant the sessions list could NEVER correctly show a
    # session as active — every session looked like it belonged to a
    # camera_id like "1" or "2" instead of "cam-01", so the frontend's
    # `sessions.find(s => s.camera_id === cam.camera_id)` never matched,
    # for any camera, ever — a session could be actively running and
    # counting in the database while the UI permanently showed "Start
    # session" as if nothing were happening.
    camera_ids = {s.camera_id for s in sessions}
    cam_map: dict[int, str] = {}
    if camera_ids:
        cam_result = await db.execute(select(Camera).where(Camera.id.in_(camera_ids)))
        cam_map = {c.id: c.camera_id for c in cam_result.scalars().all()}

    return [_session_to_response(s, camera_id_str=cam_map.get(s.camera_id)) for s in sessions]


@router.post("/sessions", response_model=SessionResponse, status_code=201)
async def create_session(
    body: SessionCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """Start a new attendance session for a camera. One open session per camera at a time."""
    # Resolve camera
    cam_result = await db.execute(
        select(Camera).where(Camera.camera_id == body.camera_id, Camera.is_active == True)
    )
    cam = cam_result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, f"Camera '{body.camera_id}' not found")

    # Close any existing open session for this camera
    open_result = await db.execute(
        select(DBSession).where(
            DBSession.camera_id == cam.id,
            DBSession.ended_at == None,
        )
    )
    for open_session in open_result.scalars().all():
        open_session.ended_at = _utcnow()
        logger.warning(
            "Session %s auto-closed because a NEW session was started for "
            "camera %s (requested by role=%s). If you didn't intentionally "
            "start a second session, something is calling POST /sessions "
            "unexpectedly.",
            open_session.session_id, body.camera_id, _.get("role"),
        )

    # Reset pipeline counter so counts start fresh for this session
    pipeline = pipeline_registry.get(body.camera_id)
    if pipeline:
        pipeline.reset_session()

    session = DBSession(
        session_id=f"sess-{uuid.uuid4().hex[:10]}",
        camera_id=cam.id,
        name=body.name,
        started_at=_utcnow(),
        venue_capacity=body.venue_capacity,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return _session_to_response(session, camera_id_str=body.camera_id)


@router.get("/sessions/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    session = await _require_session(session_id, db)
    cam_result = await db.execute(select(Camera).where(Camera.id == session.camera_id))
    cam = cam_result.scalar_one_or_none()
    return _session_to_response(session, camera_id_str=cam.camera_id if cam else None)


@router.put("/sessions/{session_id}/end", response_model=SessionResponse)
async def end_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """
    End an active session. Captures final metrics from the running pipeline
    and writes a closing AttendanceEvent snapshot.
    """
    session = await _require_session(session_id, db)
    if session.ended_at:
        raise HTTPException(400, "Session already ended")

    logger.warning(
        "Session %s ending via explicit PUT /sessions/%s/end (requested by role=%s)",
        session.session_id, session_id, _.get("role"),
    )

    # Resolve camera_id string for pipeline lookup
    cam_result = await db.execute(select(Camera).where(Camera.id == session.camera_id))
    cam = cam_result.scalar_one_or_none()
    camera_id_str = cam.camera_id if cam else None

    # Capture final metrics from the live pipeline if running
    if camera_id_str:
        pipeline = pipeline_registry.get(camera_id_str)
        if pipeline:
            snapshot = pipeline._counter.snapshot()
            session.peak_attendance = max(session.peak_attendance, snapshot.peak_attendance)
            session.total_entries = snapshot.total_entries
            session.total_exits = snapshot.total_exits

            # Write closing snapshot
            seat_states = [s.to_dict() for s in pipeline._seat_engine.seats]
            closing_event = AttendanceEvent(
                session_id=session.id,
                recorded_at=_utcnow(),
                current_attendance=snapshot.current_attendance,
                total_entries=snapshot.total_entries,
                total_exits=snapshot.total_exits,
                occupancy_percent=snapshot.occupancy_percent,
                seat_occupancy_json=seat_states,
            )
            db.add(closing_event)

    session.ended_at = _utcnow()
    await db.commit()
    await db.refresh(session)

    # Clear face-reid fingerprints now that the service is over — they
    # shouldn't persist into whatever happens on this camera next (another
    # service later, testing, etc.) per the "clear face IDs when the
    # session ends" requirement.
    if camera_id_str:
        pipeline = pipeline_registry.get(camera_id_str)
        if pipeline:
            pipeline._face_reid.reset()

    return _session_to_response(session, camera_id_str=camera_id_str)


@router.patch("/sessions/{session_id}", response_model=SessionResponse)
async def rename_session(
    session_id: str,
    body: SessionUpdate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """Rename a session."""
    session = await _require_session(session_id, db)
    session.name = body.name
    await db.commit()
    await db.refresh(session)
    cam_result = await db.execute(select(Camera).where(Camera.id == session.camera_id))
    cam = cam_result.scalar_one_or_none()
    return _session_to_response(session, camera_id_str=cam.camera_id if cam else None)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """Permanently delete a session and its attendance events."""
    session = await _require_session(session_id, db)
    # Cascade delete attendance events first
    from sqlalchemy import delete as sql_delete
    await db.execute(sql_delete(AttendanceEvent).where(AttendanceEvent.session_id == session.id))
    await db.delete(session)
    await db.commit()


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}/export")
async def export_session_csv(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """Download all attendance snapshots for a session as CSV."""
    session = await _require_session(session_id, db)

    events_result = await db.execute(
        select(AttendanceEvent)
        .where(AttendanceEvent.session_id == session.id)
        .order_by(AttendanceEvent.recorded_at.asc())
    )
    events = events_result.scalars().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "recorded_at", "current_attendance", "total_entries",
        "total_exits", "occupancy_percent",
    ])
    for e in events:
        writer.writerow([
            e.recorded_at.isoformat(),
            e.current_attendance,
            e.total_entries,
            e.total_exits,
            round(e.occupancy_percent, 2),
        ])

    output.seek(0)
    filename = f"kyro-session-{session_id}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _require_session(session_id: str, db: AsyncSession) -> DBSession:
    result = await db.execute(
        select(DBSession).where(DBSession.session_id == session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, f"Session '{session_id}' not found")
    return session


def _session_to_response(s: DBSession, camera_id_str: Optional[str] = None) -> SessionResponse:
    return SessionResponse(
        session_id=s.session_id,
        camera_id=camera_id_str or str(s.camera_id),
        name=s.name or "",
        started_at=s.started_at,
        ended_at=s.ended_at,
        venue_capacity=s.venue_capacity or 0,
        peak_attendance=s.peak_attendance or 0,
        total_entries=s.total_entries or 0,
        total_exits=s.total_exits or 0,
    )
