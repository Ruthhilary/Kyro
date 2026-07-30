"""
Kyro — Camera Management Routes

GET    /api/v1/cameras            — List all registered cameras
POST   /api/v1/cameras            — Register a new camera
GET    /api/v1/cameras/{id}       — Get camera detail
PUT    /api/v1/cameras/{id}       — Update camera config
DELETE /api/v1/cameras/{id}       — Deactivate camera
GET    /api/v1/cameras/{id}/status — Live health status (from Redis)
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import redis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt
from backend.database.connection import get_db
from backend.database.models import Camera

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/cameras", tags=["Cameras"])

_redis = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=True,
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class CameraCreate(BaseModel):
    name: str
    stream_url: str
    location: Optional[str] = None


class CameraUpdate(BaseModel):
    name: Optional[str] = None
    stream_url: Optional[str] = None
    location: Optional[str] = None
    is_active: Optional[bool] = None


class CameraResponse(BaseModel):
    camera_id: str
    name: str
    stream_url: str
    location: Optional[str]
    is_active: bool
    created_at: datetime


class CameraStatus(BaseModel):
    camera_id: str
    is_running: bool
    last_frame_timestamp: Optional[float]
    fps_actual: Optional[float]
    inference_ms: Optional[float]
    total_connections: int


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("", response_model=list[CameraResponse])
async def list_cameras(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    result = await db.execute(select(Camera).where(Camera.is_active == True))
    cameras = result.scalars().all()
    return [_to_response(c) for c in cameras]


@router.post("", response_model=CameraResponse, status_code=201)
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
    )
    db.add(camera)
    await db.commit()
    await db.refresh(camera)
    logger.info("Camera registered | id=%s name=%s", camera.camera_id, camera.name)
    return _to_response(camera)


@router.get("/{camera_id}", response_model=CameraResponse)
async def get_camera(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    camera = await _get_or_404(camera_id, db)
    return _to_response(camera)


@router.put("/{camera_id}", response_model=CameraResponse)
async def update_camera(
    camera_id: str,
    body: CameraUpdate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    camera = await _get_or_404(camera_id, db)
    updates = body.model_dump(exclude_none=True)
    for field, value in updates.items():
        setattr(camera, field, value)
    await db.commit()
    await db.refresh(camera)
    return _to_response(camera)


@router.delete("/{camera_id}", status_code=204)
async def delete_camera(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    camera = await _get_or_404(camera_id, db)
    camera.is_active = False
    await db.commit()


@router.get("/{camera_id}/status", response_model=CameraStatus)
async def get_camera_status(
    camera_id: str,
    _: dict = Depends(require_jwt),
):
    """
    Check live health of a camera worker.
    Workers publish a heartbeat key to Redis every frame:
      kyro:health:{camera_id}  →  JSON with timestamp, fps, inference_ms
    """
    key = f"kyro:health:{camera_id}"
    raw = _redis.get(key)

    if not raw:
        return CameraStatus(
            camera_id=camera_id,
            is_running=False,
            last_frame_timestamp=None,
            fps_actual=None,
            inference_ms=None,
            total_connections=0,
        )

    data = json.loads(raw)
    return CameraStatus(
        camera_id=camera_id,
        is_running=True,
        last_frame_timestamp=data.get("timestamp"),
        fps_actual=data.get("fps"),
        inference_ms=data.get("inference_ms"),
        total_connections=data.get("connections", 0),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_or_404(camera_id: str, db: AsyncSession) -> Camera:
    result = await db.execute(
        select(Camera).where(Camera.camera_id == camera_id)
    )
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
        is_active=c.is_active,
        created_at=c.created_at or datetime.now(timezone.utc),
    )
