"""
Kyro — Exclusion Zones, Rota, and Reserved Seats API

POST   /api/v1/zones/{camera_id}              — Create exclusion zone
GET    /api/v1/zones/{camera_id}              — List zones
PUT    /api/v1/zones/{camera_id}/{zone_id}    — Update zone
DELETE /api/v1/zones/{camera_id}/{zone_id}    — Remove zone

POST   /api/v1/rota/{camera_id}              — Add rota entry
GET    /api/v1/rota/{camera_id}              — List rota entries
DELETE /api/v1/rota/{camera_id}/{entry_id}   — Remove rota entry

POST   /api/v1/reserved/{camera_id}          — Reserve a seat
GET    /api/v1/reserved/{camera_id}          — List reserved seats
DELETE /api/v1/reserved/{camera_id}/{seat_id} — Unreserve a seat

All changes are hot-applied to the running pipeline immediately.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt, require_admin_or_operator, require_jwt_or_api_key
from backend.database.connection import get_db
from backend.database.models import Camera, ExclusionZone as DBZone, RotaEntry as DBRota, ReservedSeat as DBReserved
from backend.services.pipeline_registry import pipeline_registry
from ai.seat_detection.zones import ExclusionZone, ZONE_TYPES, DEFAULT_ZONE_TYPE
from ai.seat_detection.rota import RotaEntry, RotaManager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Zones & Rota"])


# ─── Helpers ─────────────────────────────────────────────────────────────────

async def _get_camera(camera_id: str, db: AsyncSession) -> Camera:
    result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, f"Camera '{camera_id}' not found")
    return cam


def _get_pipeline(camera_id: str):
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(404, f"Camera '{camera_id}' pipeline not running")
    return pipeline


# ─── Exclusion Zones ─────────────────────────────────────────────────────────

class ZoneCreate(BaseModel):
    label: str
    bbox: list[float]               # [x1, y1, x2, y2]
    # What the zone actually DOES — not derived from the label text.
    # "hold_seats" (stage/altar/choir) or "ignore" (exit/toilet/walkway).
    zone_type: str = DEFAULT_ZONE_TYPE
    hold_seats_in_rows: list[str] = []

    def validated_zone_type(self) -> str:
        return self.zone_type if self.zone_type in ZONE_TYPES else DEFAULT_ZONE_TYPE


class ZoneResponse(BaseModel):
    zone_id: str
    label: str
    zone_type: str
    bbox: list[float]
    hold_seats_in_rows: list[str]
    is_active: bool


@router.get("/api/v1/zones/{camera_id}", response_model=list[ZoneResponse])
async def list_zones(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt_or_api_key),
):
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBZone).where(DBZone.camera_id == cam.id, DBZone.is_active == True)
    )
    return [ZoneResponse(
        zone_id=z.zone_id, label=z.label, zone_type=z.zone_type or DEFAULT_ZONE_TYPE, bbox=z.bbox,
        hold_seats_in_rows=z.hold_seats_in_rows or [], is_active=z.is_active,
    ) for z in result.scalars().all()]


@router.post("/api/v1/zones/{camera_id}", response_model=ZoneResponse, status_code=201)
async def create_zone(
    camera_id: str,
    body: ZoneCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    cam = await _get_camera(camera_id, db)
    zone_id = f"zone-{uuid4().hex[:8]}"
    zone_type = body.validated_zone_type()

    db_zone = DBZone(
        camera_id=cam.id,
        zone_id=zone_id,
        label=body.label,
        zone_type=zone_type,
        bbox=body.bbox,
        hold_seats_in_rows=body.hold_seats_in_rows,
        is_active=True,
    )
    db.add(db_zone)
    await db.commit()

    # Hot-apply to running pipeline
    _apply_zones_to_pipeline(camera_id, await _load_zones(cam.id, db))

    logger.info("Exclusion zone created | camera=%s zone=%s label=%r type=%s",
                camera_id, zone_id, body.label, zone_type)
    return ZoneResponse(zone_id=zone_id, label=body.label, zone_type=zone_type, bbox=body.bbox,
                        hold_seats_in_rows=body.hold_seats_in_rows, is_active=True)


@router.put("/api/v1/zones/{camera_id}/{zone_id}", response_model=ZoneResponse)
async def update_zone(
    camera_id: str,
    zone_id: str,
    body: ZoneCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBZone).where(DBZone.camera_id == cam.id, DBZone.zone_id == zone_id)
    )
    db_zone = result.scalar_one_or_none()
    if not db_zone:
        raise HTTPException(404, f"Zone '{zone_id}' not found")

    zone_type = body.validated_zone_type()
    db_zone.label = body.label
    db_zone.zone_type = zone_type
    db_zone.bbox = body.bbox
    db_zone.hold_seats_in_rows = body.hold_seats_in_rows
    await db.commit()

    _apply_zones_to_pipeline(camera_id, await _load_zones(cam.id, db))
    return ZoneResponse(zone_id=zone_id, label=body.label, zone_type=zone_type, bbox=body.bbox,
                        hold_seats_in_rows=body.hold_seats_in_rows, is_active=True)


@router.delete("/api/v1/zones/{camera_id}/{zone_id}", status_code=204)
async def delete_zone(
    camera_id: str,
    zone_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBZone).where(DBZone.camera_id == cam.id, DBZone.zone_id == zone_id)
    )
    db_zone = result.scalar_one_or_none()
    if not db_zone:
        raise HTTPException(404, f"Zone '{zone_id}' not found")
    db_zone.is_active = False
    await db.commit()
    _apply_zones_to_pipeline(camera_id, await _load_zones(cam.id, db))


# ─── Rota ─────────────────────────────────────────────────────────────────────

class RotaCreate(BaseModel):
    label: str
    start_time: datetime
    end_time: datetime
    seat_ids: list[str] = []
    rows: list[str] = []
    section: Optional[str] = None


class RotaResponse(BaseModel):
    entry_id: str
    label: str
    start_time: datetime
    end_time: datetime
    seat_ids: list[str]
    rows: list[str]
    section: Optional[str]
    is_active: bool


@router.get("/api/v1/rota/{camera_id}", response_model=list[RotaResponse])
async def list_rota(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt_or_api_key),
):
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBRota).where(DBRota.camera_id == cam.id, DBRota.is_active == True)
                      .order_by(DBRota.start_time)
    )
    return [_rota_response(r) for r in result.scalars().all()]


@router.post("/api/v1/rota/{camera_id}", response_model=RotaResponse, status_code=201)
async def create_rota_entry(
    camera_id: str,
    body: RotaCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    cam = await _get_camera(camera_id, db)
    entry_id = f"rota-{uuid4().hex[:8]}"

    db_entry = DBRota(
        camera_id=cam.id,
        entry_id=entry_id,
        label=body.label,
        start_time=body.start_time.replace(tzinfo=None),
        end_time=body.end_time.replace(tzinfo=None),
        seat_ids=body.seat_ids,
        rows=body.rows,
        section=body.section,
        is_active=True,
    )
    db.add(db_entry)
    await db.commit()

    # Hot-apply to running pipeline
    _apply_rota_to_pipeline(camera_id, await _load_rota(cam.id, db))

    logger.info("Rota entry created | camera=%s entry=%s label=%r seats=%s rows=%s",
                camera_id, entry_id, body.label, body.seat_ids, body.rows)
    return _rota_response(db_entry)


@router.delete("/api/v1/rota/{camera_id}/{entry_id}", status_code=204)
async def delete_rota_entry(
    camera_id: str,
    entry_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBRota).where(DBRota.camera_id == cam.id, DBRota.entry_id == entry_id)
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(404, f"Rota entry '{entry_id}' not found")
    entry.is_active = False
    await db.commit()

    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        pipeline._seat_engine.rota.remove(entry_id)


# ─── Reserved Seats ───────────────────────────────────────────────────────────

class ReservedCreate(BaseModel):
    seat_id: str
    reserved_for: Optional[str] = None
    note: Optional[str] = None


class ReservedResponse(BaseModel):
    seat_id: str
    reserved_for: Optional[str]
    note: Optional[str]


@router.get("/api/v1/reserved/{camera_id}", response_model=list[ReservedResponse])
async def list_reserved(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_jwt_or_api_key),
):
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBReserved).where(DBReserved.camera_id == cam.id, DBReserved.is_active == True)
    )
    return [ReservedResponse(seat_id=r.seat_id, reserved_for=r.reserved_for, note=r.note)
            for r in result.scalars().all()]


@router.post("/api/v1/reserved/{camera_id}", response_model=ReservedResponse, status_code=201)
async def reserve_seat(
    camera_id: str,
    body: ReservedCreate,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    cam = await _get_camera(camera_id, db)

    # Upsert in DB
    result = await db.execute(
        select(DBReserved).where(
            DBReserved.camera_id == cam.id,
            DBReserved.seat_id == body.seat_id,
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.reserved_for = body.reserved_for
        existing.note = body.note
        existing.is_active = True
    else:
        db.add(DBReserved(
            camera_id=cam.id,
            seat_id=body.seat_id,
            reserved_for=body.reserved_for,
            note=body.note,
            is_active=True,
        ))
    await db.commit()

    # Hot-apply to running pipeline
    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        pipeline._seat_engine.set_reserved(body.seat_id, True, body.reserved_for)

    logger.info("Seat reserved | camera=%s seat=%s for=%r", camera_id, body.seat_id, body.reserved_for)
    return ReservedResponse(seat_id=body.seat_id, reserved_for=body.reserved_for, note=body.note)


@router.delete("/api/v1/reserved/{camera_id}", status_code=204)
async def clear_all_reserved(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    """Clear every reserved seat for a camera. Requires admin/operator + called via password-protected UI."""
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBReserved).where(DBReserved.camera_id == cam.id, DBReserved.is_active == True)
    )
    entries = result.scalars().all()
    cleared_ids = [e.seat_id for e in entries]
    for entry in entries:
        entry.is_active = False

    await db.commit()

    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        for seat_id in cleared_ids:
            pipeline._seat_engine.set_reserved(seat_id, False)

    logger.info("All reserved seats cleared | camera=%s count=%d", camera_id, len(cleared_ids))


@router.delete("/api/v1/reserved/{camera_id}/{seat_id}", status_code=204)
async def unreserve_seat(
    camera_id: str,
    seat_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_admin_or_operator),
):
    cam = await _get_camera(camera_id, db)
    result = await db.execute(
        select(DBReserved).where(
            DBReserved.camera_id == cam.id, DBReserved.seat_id == seat_id
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(404, f"Reserved seat '{seat_id}' not found")
    entry.is_active = False
    await db.commit()

    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        pipeline._seat_engine.set_reserved(seat_id, False)


# ─── Startup loader — called by worker on start ───────────────────────────────

async def load_policies_for_camera(camera_id: str, cam_db_id: int, db: AsyncSession) -> dict:
    """
    Load all zones, rota entries, and reserved seats for a camera from the DB.
    Returns dicts ready for the worker to apply to the pipeline.
    """
    zones   = await _load_zones(cam_db_id, db)
    rota    = await _load_rota(cam_db_id, db)
    reserved = await _load_reserved(cam_db_id, db)
    return {"zones": zones, "rota": rota, "reserved": reserved}


# ─── Internal helpers ─────────────────────────────────────────────────────────

async def _load_zones(cam_db_id: int, db: AsyncSession) -> list[ExclusionZone]:
    result = await db.execute(
        select(DBZone).where(DBZone.camera_id == cam_db_id, DBZone.is_active == True)
    )
    return [
        ExclusionZone(
            zone_id=z.zone_id,
            bbox=np.array(z.bbox, dtype=np.float32),
            label=z.label or "",
            zone_type=z.zone_type or DEFAULT_ZONE_TYPE,
            hold_seats_in_rows=z.hold_seats_in_rows or [],
        )
        for z in result.scalars().all()
    ]


async def _load_rota(cam_db_id: int, db: AsyncSession) -> list[RotaEntry]:
    result = await db.execute(
        select(DBRota).where(DBRota.camera_id == cam_db_id, DBRota.is_active == True)
    )
    import time as _t
    entries = []
    for r in result.scalars().all():
        entries.append(RotaEntry(
            entry_id=r.entry_id,
            label=r.label,
            start_epoch=r.start_time.replace(tzinfo=timezone.utc).timestamp(),
            end_epoch=r.end_time.replace(tzinfo=timezone.utc).timestamp(),
            seat_ids=r.seat_ids or [],
            rows=r.rows or [],
            section=r.section,
        ))
    return entries


async def _load_reserved(cam_db_id: int, db: AsyncSession) -> list[dict]:
    result = await db.execute(
        select(DBReserved).where(DBReserved.camera_id == cam_db_id, DBReserved.is_active == True)
    )
    return [{"seat_id": r.seat_id, "reserved_for": r.reserved_for} for r in result.scalars().all()]


def _apply_zones_to_pipeline(camera_id: str, zones: list[ExclusionZone]) -> None:
    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        pipeline._seat_engine.set_exclusion_zones(zones)


def _apply_rota_to_pipeline(camera_id: str, entries: list[RotaEntry]) -> None:
    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        pipeline._seat_engine.rota.load(entries)


def _rota_response(r: DBRota) -> RotaResponse:
    return RotaResponse(
        entry_id=r.entry_id,
        label=r.label,
        start_time=r.start_time,
        end_time=r.end_time,
        seat_ids=r.seat_ids or [],
        rows=r.rows or [],
        section=r.section,
        is_active=r.is_active,
    )
