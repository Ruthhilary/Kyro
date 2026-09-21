"""
Kyro — Camera Management Routes

GET    /api/v1/cameras              — List all registered cameras
POST   /api/v1/cameras              — Register a new camera
GET    /api/v1/cameras/{id}         — Get camera detail
PUT    /api/v1/cameras/{id}         — Update camera config
DELETE /api/v1/cameras/{id}         — Deactivate camera
GET    /api/v1/cameras/{id}/status  — Live health status (from Redis)
GET    /api/v1/venue/total          — Venue-wide total across all zones (deduped)
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import redis
import redis.asyncio as aioredis
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt, require_admin_or_operator, require_jwt_or_api_key, require_jwt_header_or_query
from backend.database.connection import get_db
from backend.database.models import Camera
from backend.services.pipeline_registry import pipeline_registry

load_dotenv(override=False)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Cameras"])

_redis = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=True,
)

# Separate client for binary snapshot data (no decode_responses)
_redis_bytes = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=False,
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class CameraCreate(BaseModel):
    name: str
    stream_url: str
    location: Optional[str] = None
    zone_name: Optional[str] = None
    zone_capacity: int = 0
    zone_order: int = 0


class CameraUpdate(BaseModel):
    name: Optional[str] = None
    stream_url: Optional[str] = None
    location: Optional[str] = None
    zone_name: Optional[str] = None
    zone_capacity: Optional[int] = None
    zone_order: Optional[int] = None
    is_active: Optional[bool] = None


class CameraResponse(BaseModel):
    camera_id: str
    name: str
    stream_url: str
    location: Optional[str]
    zone_name: Optional[str]
    zone_capacity: int
    zone_order: int
    is_active: bool
    created_at: datetime


class CameraStatus(BaseModel):
    camera_id: str
    is_running: bool
    # "online" | "offline" | "error" — offline means no heartbeat at all
    # (worker/stream down); error means frames ARE flowing but look
    # blank/frozen (camera physically failed without OpenCV noticing —
    # see ai/worker.py's _camera_error_status).
    status: str = "offline"
    error_reason: Optional[str] = None
    last_frame_timestamp: Optional[float]
    fps_actual: Optional[float]
    inference_ms: Optional[float]
    total_connections: int


class ZoneLive(BaseModel):
    """Live metrics for one zone/camera."""
    camera_id: str
    zone_name: str
    camera_name: str
    current: int
    peak: int
    entries: int
    exits: int
    capacity: int
    occupancy_pct: float
    is_running: bool
    status: str = "offline"
    error_reason: Optional[str] = None


class VenueTotalResponse(BaseModel):
    """Summed across all non-overlapping zones."""
    total_current: int
    total_peak: int
    total_entries: int
    total_exits: int
    total_capacity: int
    venue_occupancy_pct: float
    zones: list[ZoneLive]
    cameras_running: int
    cameras_total: int


# ---------------------------------------------------------------------------
# Camera CRUD
# ---------------------------------------------------------------------------

@router.get("/api/v1/cameras", response_model=list[CameraResponse])
async def list_cameras(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    result = await db.execute(
        select(Camera).where(Camera.is_active == True).order_by(Camera.zone_order, Camera.id)
    )
    return [_to_response(c) for c in result.scalars().all()]


@router.post("/api/v1/cameras", response_model=CameraResponse, status_code=201)
async def create_camera(
    body: CameraCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    camera = Camera(
        camera_id=f"cam-{uuid4().hex[:8]}",
        name=body.name,
        stream_url=body.stream_url,
        location=body.location,
        zone_name=body.zone_name or body.name,
        zone_capacity=body.zone_capacity,
        zone_order=body.zone_order,
    )
    db.add(camera)
    await db.commit()
    await db.refresh(camera)
    logger.info("Camera registered | id=%s name=%s zone=%s", camera.camera_id, camera.name, camera.zone_name)
    return _to_response(camera)


@router.get("/api/v1/cameras/{camera_id}", response_model=CameraResponse)
async def get_camera(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt_or_api_key),
):
    return _to_response(await _get_or_404(camera_id, db))


@router.put("/api/v1/cameras/{camera_id}", response_model=CameraResponse)
async def update_camera(
    camera_id: str,
    body: CameraUpdate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    camera = await _get_or_404(camera_id, db)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(camera, field, value)
    await db.commit()
    await db.refresh(camera)
    return _to_response(camera)


@router.delete("/api/v1/cameras/{camera_id}", status_code=204)
async def delete_camera(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """
    Permanently removes the camera row from the database.
    Also stops and unregisters any running pipeline for this camera.
    """
    camera = await _get_or_404(camera_id, db)

    # Stop the running pipeline if one exists
    pipeline_registry.unregister(camera_id)

    # Drop its alert state, otherwise the watcher keeps a stale "was online"
    # record and a camera re-added under the same ID later would fire a
    # spurious offline/recovery pair based on the deleted camera's history.
    try:
        from backend.services import alert_store
        alert_store.forget_camera(camera_id)
    except Exception:
        pass

    # Hard delete — gone for good
    await db.delete(camera)
    await db.commit()
    logger.info("Camera permanently deleted | id=%s name=%s", camera_id, camera.name)


@router.get("/api/v1/cameras/{camera_id}/status", response_model=CameraStatus)
async def get_camera_status(camera_id: str, _: dict = Depends(require_jwt)):
    key = f"kyro:health:{camera_id}"
    raw = _redis.get(key)
    if not raw:
        return CameraStatus(camera_id=camera_id, is_running=False, status="offline",
                            last_frame_timestamp=None, fps_actual=None,
                            inference_ms=None, total_connections=0)
    data = json.loads(raw)
    status = data.get("status", "online")  # older heartbeats won't have this field
    return CameraStatus(
        camera_id=camera_id,
        is_running=True,
        status=status,
        error_reason=data.get("error_reason"),
        last_frame_timestamp=data.get("timestamp"),
        fps_actual=data.get("fps"),
        inference_ms=data.get("inference_ms"),
        total_connections=data.get("connections", 0),
    )


@router.get("/api/v1/cameras/{camera_id}/snapshot")
async def get_camera_snapshot(
    camera_id: str,
    _: dict = Depends(require_jwt),
):
    """
    Returns the latest annotated JPEG frame from the vision worker.
    Kept as a fallback for callers that just want one still image (e.g.
    review-answer emails) — the dashboard itself now uses /stream below
    for the live view instead of polling this repeatedly.
    """
    data = _redis_bytes.get(f"kyro:snapshot:{camera_id}")
    if not data:
        return Response(status_code=204)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Camera-Id": camera_id,
        },
    )


@router.get("/api/v1/cameras/{camera_id}/stream")
async def stream_camera(
    camera_id: str,
    token: Optional[str] = None,
    _: dict = Depends(require_jwt_header_or_query),
):
    """
    Live MJPEG stream (multipart/x-mixed-replace) — replaces the old
    snapshot-every-2-seconds polling. The vision worker now publishes every
    processed frame to a Redis pub/sub channel (kyro:frame:{camera_id});
    this endpoint subscribes and relays each frame to the browser as it
    arrives. A plain <img src="..."> tag renders this natively — no
    client-side JS polling loop needed.

    Auth accepts either a Bearer header or a `?token=` query param, since
    <img> tags can't set custom headers — see require_jwt_header_or_query.
    """
    channel = f"kyro:frame:{camera_id}"
    boundary = "kyroframe"

    async def frame_generator():
        client = aioredis.Redis(
            host=os.environ.get("REDIS_HOST", "localhost"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            decode_responses=False,
        )
        pubsub = client.pubsub()
        await pubsub.subscribe(channel)
        try:
            # Send the last known frame immediately so the viewer isn't
            # staring at a blank box waiting for the next publish.
            last = _redis_bytes.get(f"kyro:snapshot:{camera_id}")
            if last:
                yield (
                    f"--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(last)}\r\n\r\n"
                ).encode() + last + b"\r\n"

            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                jpeg_bytes = message["data"]
                yield (
                    f"--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg_bytes)}\r\n\r\n"
                ).encode() + jpeg_bytes + b"\r\n"
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()
            await client.close()

    return StreamingResponse(
        frame_generator(),
        media_type=f"multipart/x-mixed-replace; boundary={boundary}",
        headers={"Cache-Control": "no-store", "X-Camera-Id": camera_id},
    )


# ---------------------------------------------------------------------------
# Venue total — sums all active zones (no double counting)
# ---------------------------------------------------------------------------

@router.get("/api/v1/venue/total", response_model=VenueTotalResponse)
async def get_venue_total(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """
    Returns a venue-wide attendance total by summing each zone's live count.
    Each camera covers a distinct zone — no overlap — so summing is safe.
    Cameras with no running worker contribute 0 to the total.
    """
    result = await db.execute(
        select(Camera).where(Camera.is_active == True).order_by(Camera.zone_order, Camera.id)
    )
    cameras = result.scalars().all()

    zones: list[ZoneLive] = []
    total_current = 0
    total_peak = 0
    total_entries = 0
    total_exits = 0
    total_capacity = 0
    cameras_running = 0

    for cam in cameras:
        # 1. Try in-process pipeline (embedded mode)
        pipeline   = pipeline_registry.get(cam.camera_id)
        is_running = False
        status     = "offline"
        error_reason = None
        current = peak = entries = exits = 0
        occ_pct = 0.0

        if pipeline is not None:
            try:
                snap     = pipeline._counter.snapshot()
                current  = snap.current_attendance
                peak     = snap.peak_attendance
                entries  = snap.total_entries
                exits    = snap.total_exits
                occ_pct  = snap.occupancy_percent
                is_running = True
                status = "online"
            except Exception:
                pass

        # 2. Fall back to Redis health key (external worker process)
        if not is_running:
            raw = _redis.get(f"kyro:health:{cam.camera_id}")
            if raw:
                try:
                    health     = json.loads(raw)
                    current    = int(health.get("current", 0))
                    is_running = True
                    status     = health.get("status", "online")
                    error_reason = health.get("error_reason")
                except Exception:
                    pass

        if is_running:
            cameras_running += 1

        zone_cap = cam.zone_capacity or 0
        total_current  += current
        total_peak     += peak
        total_entries  += entries
        total_exits    += exits
        total_capacity += zone_cap

        zones.append(ZoneLive(
            camera_id=cam.camera_id,
            zone_name=cam.zone_name or cam.name,
            camera_name=cam.name,
            current=current,
            peak=peak,
            entries=entries,
            exits=exits,
            capacity=zone_cap,
            occupancy_pct=round(occ_pct, 1),
            is_running=is_running,
            status=status,
            error_reason=error_reason,
        ))

    venue_occ = round((total_current / total_capacity * 100), 1) if total_capacity > 0 else 0.0

    return VenueTotalResponse(
        total_current=total_current,
        total_peak=total_peak,
        total_entries=total_entries,
        total_exits=total_exits,
        total_capacity=total_capacity,
        venue_occupancy_pct=venue_occ,
        zones=zones,
        cameras_running=cameras_running,
        cameras_total=len(cameras),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_or_404(camera_id: str, db: AsyncSession) -> Camera:
    result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    camera = result.scalar_one_or_none()
    if not camera:
        raise HTTPException(status_code=404, detail=f"Camera '{camera_id}' not found")
    return camera


def _to_response(c: Camera) -> CameraResponse:
    return CameraResponse(
        camera_id=c.camera_id,
        name=c.name,
        stream_url=c.stream_url,
        location=c.location,
        zone_name=c.zone_name,
        zone_capacity=c.zone_capacity or 0,
        zone_order=c.zone_order or 0,
        is_active=c.is_active,
        created_at=c.created_at or datetime.now(timezone.utc),
    )
