"""
Kyro — Seat Routes

Live state (from running pipeline):
  GET  /api/v1/seats/{camera_id}             — All seat states
  GET  /api/v1/seats/{camera_id}/available   — Available seats (usher view)
  GET  /api/v1/seats/{camera_id}/summary     — Occupancy counts

Layout editor (persisted to DB):
  GET    /api/v1/seats/{camera_id}/layouts         — List saved layouts
  POST   /api/v1/seats/{camera_id}/layouts         — Save a new layout
  GET    /api/v1/seats/{camera_id}/layouts/{lid}   — Get layout detail
  PUT    /api/v1/seats/{camera_id}/layouts/{lid}   — Update layout
  DELETE /api/v1/seats/{camera_id}/layouts/{lid}   — Delete layout
  POST   /api/v1/seats/{camera_id}/layouts/{lid}/activate — Load layout into pipeline
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import redis
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt, require_admin_or_operator, require_jwt_header_or_query
from backend.database.connection import get_db
from backend.database.models import Camera, SeatLayout, ReservedSeat
from backend.services.pipeline_registry import pipeline_registry
from ai.seat_detection.seat import Seat

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/seats", tags=["Seats"])

_redis_bytes = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=False,
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SeatDefinition(BaseModel):
    """One seat definition for layout editor input/output."""
    seat_id: str
    row: str
    number: int
    section: str = "Main"
    bbox: list[float]   # [x1, y1, x2, y2] in camera frame pixels


class SeatStateResponse(BaseModel):
    seat_id: str
    row: str
    number: int
    section: str
    state: str
    confidence: float
    occupying_track_id: Optional[int]
    bbox: list[float]


class LayoutCreate(BaseModel):
    name: str
    seats: list[SeatDefinition]


class LayoutResponse(BaseModel):
    id: int
    camera_id: str
    name: str
    is_active: bool
    seat_count: int
    created_at: datetime
    seats: list[SeatDefinition]


# ---------------------------------------------------------------------------
# Live state routes
# ---------------------------------------------------------------------------

@router.get("/{camera_id}", response_model=list[SeatStateResponse])
async def get_seat_states(camera_id: str, _: dict = Depends(require_jwt)):
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(404, f"Camera '{camera_id}' not running")
    return [SeatStateResponse(**s) for s in [seat.to_dict() for seat in pipeline._seat_engine.seats]]


@router.get("/{camera_id}/available", response_model=list[SeatStateResponse])
async def get_available_seats(camera_id: str, _: dict = Depends(require_jwt)):
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(404, f"Camera '{camera_id}' not running")
    available = [seat.to_dict() for seat in pipeline._seat_engine.seats if seat.is_available_for_usher]
    return [SeatStateResponse(**s) for s in available]


@router.get("/{camera_id}/{seat_id}/available-snapshot")
async def get_seat_available_snapshot(
    camera_id: str,
    seat_id: str,
    token: Optional[str] = None,
    claims: dict = Depends(require_jwt_header_or_query),
):
    """
    Returns the evidence photo captured at the moment this seat became
    available — the worker crops this around the seat's known bbox (with
    surrounding context) the instant the state transitions, not on every
    request, and stores it for 10 minutes. Auth accepts either a Bearer
    header or a `?token=` query param since an <img> tag (used for the
    zoomable view) can't set a custom header — see
    require_jwt_header_or_query.
    """
    role = claims.get("role", "viewer")
    # Deliberately open to every authenticated role, including "viewer"
    # (ushers) — they're exactly who needs to see this to walk someone to
    # the seat. Unlike most seat-management endpoints, there's no reason
    # to restrict this one to admin/operator.
    data = _redis_bytes.get(f"kyro:seat_alert_snap:{camera_id}:{seat_id}")
    if not data:
        return Response(status_code=204)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{camera_id}/summary")
async def get_seat_summary(camera_id: str, _: dict = Depends(require_jwt)):
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(404, f"Camera '{camera_id}' not running")
    return pipeline._seat_engine.occupancy_summary


@router.post("/{camera_id}/full-reset", status_code=200)
async def full_seat_reset(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """
    Full venue reset:
    - Clears all reserved seats from DB
    - Clears all reserved flags from every seat in the pipeline
    - Resets all seat states to UNKNOWN so the AI re-detects from scratch
    - Resets attendance counter (entries/exits/peak) to zero
    """
    cam = await _require_camera(camera_id, db)

    # 1. Clear all reservations in DB
    result = await db.execute(
        select(ReservedSeat).where(ReservedSeat.camera_id == cam.id, ReservedSeat.is_active == True)
    )
    entries = result.scalars().all()
    for entry in entries:
        entry.is_active = False
    await db.commit()

    # 2. Full pipeline reset — clears seat states + removes reserved flags + resets counter
    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        for seat in pipeline._seat_engine.seats:
            seat.reserved = False
            seat.reserved_for = None
        pipeline.reset_session()  # resets all seat states to UNKNOWN + resets counter

    logger.info("Full seat reset | camera=%s reservations_cleared=%d", camera_id, len(entries))
    return {"reset": True, "reservations_cleared": len(entries)}


# ---------------------------------------------------------------------------
# Layout editor routes
# ---------------------------------------------------------------------------

@router.get("/{camera_id}/layouts", response_model=list[LayoutResponse])
async def list_layouts(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    cam = await _require_camera(camera_id, db)
    result = await db.execute(
        select(SeatLayout).where(SeatLayout.camera_id == cam.id)
    )
    return [_layout_to_response(cam.camera_id, lay) for lay in result.scalars().all()]


@router.post("/{camera_id}/layouts", response_model=LayoutResponse, status_code=201)
async def create_layout(
    camera_id: str,
    body: LayoutCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """Save a new seat layout. The layout editor POSTs seat definitions here."""
    cam = await _require_camera(camera_id, db)
    layout = SeatLayout(
        camera_id=cam.id,
        name=body.name,
        seats_json=[s.model_dump() for s in body.seats],
        is_active=False,
    )
    db.add(layout)
    await db.commit()
    await db.refresh(layout)
    logger.info("Seat layout saved | camera=%s name=%s seats=%d", camera_id, body.name, len(body.seats))
    return _layout_to_response(camera_id, layout)


@router.get("/{camera_id}/layouts/{lid}", response_model=LayoutResponse)
async def get_layout(
    camera_id: str,
    lid: int,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    cam = await _require_camera(camera_id, db)
    layout = await _require_layout(lid, cam.id, db)
    return _layout_to_response(camera_id, layout)


@router.put("/{camera_id}/layouts/{lid}", response_model=LayoutResponse)
async def update_layout(
    camera_id: str,
    lid: int,
    body: LayoutCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    cam = await _require_camera(camera_id, db)
    layout = await _require_layout(lid, cam.id, db)
    layout.name = body.name
    layout.seats_json = [s.model_dump() for s in body.seats]
    await db.commit()
    await db.refresh(layout)
    return _layout_to_response(camera_id, layout)


@router.delete("/{camera_id}/layouts/{lid}", status_code=204)
async def delete_layout(
    camera_id: str,
    lid: int,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    cam = await _require_camera(camera_id, db)
    layout = await _require_layout(lid, cam.id, db)
    await db.delete(layout)
    await db.commit()


@router.post("/{camera_id}/layouts/{lid}/activate", status_code=200)
async def activate_layout(
    camera_id: str,
    lid: int,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt),
):
    """
    Load a saved layout into the running pipeline.
    This replaces the pipeline's seat list with the saved definitions.
    Also marks this layout as active and deactivates all others for this camera.
    """
    cam = await _require_camera(camera_id, db)
    layout = await _require_layout(lid, cam.id, db)

    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(404, f"Camera '{camera_id}' pipeline not running — start the worker first")

    # Build Seat objects from stored definitions
    new_seats = [
        Seat(
            seat_id=s["seat_id"],
            bbox=np.array(s["bbox"], dtype=np.float32),
            row=s["row"],
            number=s["number"],
            section=s.get("section", "Main"),
        )
        for s in layout.seats_json
    ]

    # Hot-swap seats in the running pipeline's occupancy engine
    pipeline._seat_engine._seats = new_seats
    logger.info(
        "Layout activated | camera=%s layout=%s seats=%d",
        camera_id, layout.name, len(new_seats),
    )

    # Mark active in DB
    all_layouts = await db.execute(
        select(SeatLayout).where(SeatLayout.camera_id == cam.id)
    )
    for lay in all_layouts.scalars().all():
        lay.is_active = lay.id == lid
    await db.commit()

    return {"activated": True, "layout_id": lid, "seat_count": len(new_seats)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _require_camera(camera_id: str, db: AsyncSession) -> Camera:
    result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        # Auto-create a camera entry so layout saves work even for demo/default camera IDs
        cam = Camera(
            camera_id  = camera_id,
            name       = camera_id,
            stream_url = "demo://",
            zone_name  = camera_id,
            zone_capacity = 0,
            zone_order    = 0,
        )
        db.add(cam)
        await db.commit()
        await db.refresh(cam)
    return cam


async def _require_layout(lid: int, camera_db_id: int, db: AsyncSession) -> SeatLayout:
    result = await db.execute(
        select(SeatLayout).where(SeatLayout.id == lid, SeatLayout.camera_id == camera_db_id)
    )
    layout = result.scalar_one_or_none()
    if not layout:
        raise HTTPException(404, f"Layout {lid} not found")
    return layout


def _layout_to_response(camera_id: str, layout: SeatLayout) -> LayoutResponse:
    seats_data = layout.seats_json or []
    return LayoutResponse(
        id=layout.id,
        camera_id=camera_id,
        name=layout.name,
        is_active=layout.is_active,
        seat_count=len(seats_data),
        created_at=layout.created_at or datetime.now(timezone.utc),
        seats=[SeatDefinition(**s) for s in seats_data],
    )
