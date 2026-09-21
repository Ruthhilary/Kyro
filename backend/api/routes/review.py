"""
Kyro — Live Review API (admin-only)

POST /api/v1/review/{camera_id}/answer  — Admin answers an AI question
GET  /api/v1/review/{camera_id}/pending — List unanswered questions
GET  /api/v1/review/{camera_id}/memory  — View what the system has learned

Review questions are ADMIN-ONLY. Ushers/operators cannot see or answer them.
Answers are persisted to the DB immediately so the system never asks
about the same spatial region again across restarts and future services.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import redis
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_jwt, require_admin_or_operator, require_jwt_or_api_key
from backend.database.connection import get_db
from backend.database.models import Camera, SpatialMemory, ExclusionZone as DBZone
from backend.services.pipeline_registry import pipeline_registry

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Review"])

_redis = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=True,
)

_redis_bytes = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=False,
)


# ─── Require admin ────────────────────────────────────────────────────────────

async def require_admin(claims: dict = Depends(require_jwt)) -> dict:
    """Spatial review questions (stage/zone) are admin-only."""
    if claims.get("role") != "admin":
        raise HTTPException(403, "Spatial review questions are only accessible to admins")
    return claims


async def require_admin_or_operator(claims: dict = Depends(require_jwt)) -> dict:
    if claims.get("role") not in ("admin", "operator"):
        raise HTTPException(403, "Access restricted")
    return claims


# ─── Schemas ─────────────────────────────────────────────────────────────────

class ReviewAnswerRequest(BaseModel):
    review_id: str
    answer: str


class ReviewAnswerResponse(BaseModel):
    review_id:           str
    track_id:            int
    movement:            str
    seat_id:             Optional[str]
    answer:              str
    zone_auto_created:   bool = False
    zone_id:             Optional[str] = None


class MemoryEntry(BaseModel):
    region_key:         str
    cx:                 float
    cy:                 float
    classification:     str
    confirmation_count: int
    auto_zone_created:  bool


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.post("/api/v1/review/{camera_id}/answer", response_model=ReviewAnswerResponse)
async def answer_review(
    camera_id: str,
    body: ReviewAnswerRequest,
    claims: dict = Depends(require_jwt),
    db: AsyncSession = Depends(get_db),
):
    """
    Submit a human answer to a review request.
    Spatial questions (stage/zone): admin only.
    People questions (absence/front_rush): operator or admin.
    """
    role = claims.get("role", "viewer")
    if role not in ("admin", "operator"):
        raise HTTPException(403, "Insufficient role — admin or operator required")

    # Enforce per-type role: spatial questions are admin-only
    # We check the stored request's review_type if available
    raw = _redis.get(f"kyro:review:{camera_id}:{body.review_id}")
    if raw:
        try:
            req_data = json.loads(raw)
            rt = req_data.get("review_type", "")
            if rt in ("stage_question", "zone_proposal") and role != "admin":
                raise HTTPException(403, "Only admins can answer spatial review questions")
        except HTTPException:
            raise
        except Exception:
            pass

    cam_result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    cam = cam_result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, f"Camera '{camera_id}' not found")

    pipeline   = pipeline_registry.get(camera_id)
    result_data: Optional[dict] = None

    if pipeline:
        # In-process pipeline (embedded mode)
        result_data = pipeline._movement.apply_answer(body.review_id, body.answer)
        # Drain persistence queue
        to_persist = pipeline._movement.review_queue.drain_persist_queue()
    else:
        # External worker — send answer via Redis, reconstruct result from stored request
        _redis.publish(
            f"kyro:review_answer:{camera_id}",
            json.dumps({"type": "review_answer", "review_id": body.review_id, "answer": body.answer}),
        )
        raw = _redis.get(f"kyro:review:{camera_id}:{body.review_id}")
        if raw:
            req_data = json.loads(raw)
            result_data = {
                "review_id":    body.review_id,
                "track_id":     req_data.get("track_id", 0),
                "movement":     _answer_to_movement(body.answer),
                "seat_id":      req_data.get("seat_id"),
                "answer":       body.answer,
                "zone_proposals": [],
                "bbox_hint":    req_data.get("bbox_hint"),
                "position":     req_data.get("position", [0.0, 0.0]),
            }
            _redis.delete(f"kyro:review:{camera_id}:{body.review_id}")
        # Build persistence item from the request data
        to_persist = []
        if result_data and result_data.get("movement") in ("stage_move", "exit", "absence"):
            pos = result_data.get("position", [0.0, 0.0])
            if pos and pos != [0.0, 0.0]:
                GRID = 64
                key  = f"{int(pos[0] / GRID)}:{int(pos[1] / GRID)}"
                to_persist = [{
                    "camera_id":          camera_id,
                    "region_key":         key,
                    "cx":                 float(pos[0]),
                    "cy":                 float(pos[1]),
                    "classification":     result_data["movement"],
                    "confirmation_count": 1,
                    "auto_zone_created":  False,
                    "create_zone":        False,
                    "suggested_bbox":     result_data.get("bbox_hint"),
                }]

    if not result_data:
        raise HTTPException(404, f"Review '{body.review_id}' not found or already answered")

    # ── Persist learned regions to DB ─────────────────────────────────
    zone_auto_created = False
    zone_id: Optional[str] = None

    for item in to_persist:
        zone_auto_created, zone_id = await _persist_memory_item(
            item, cam, db, camera_id,
        )

    await db.commit()

    # Reload memory into pipeline if running
    if pipeline:
        await _reload_pipeline_memory(camera_id, cam.id, db, pipeline)

    return ReviewAnswerResponse(
        review_id=result_data["review_id"],
        track_id=result_data["track_id"],
        movement=result_data["movement"],
        seat_id=result_data.get("seat_id"),
        answer=body.answer,
        zone_auto_created=zone_auto_created,
        zone_id=zone_id,
    )


@router.get("/api/v1/review/{camera_id}/snapshot/{review_id}")
async def get_review_snapshot(
    camera_id: str,
    review_id: str,
    claims: dict = Depends(require_jwt),
):
    """
    Returns the cropped JPEG snapshot saved when the review request was raised.
    Shows the specific person/area the AI is asking about, zoomed in.
    """
    role = claims.get("role", "viewer")
    if role not in ("admin", "operator"):
        raise HTTPException(403, "Insufficient role")
    data = _redis_bytes.get(f"kyro:review_snap:{camera_id}:{review_id}")
    if not data:
        return Response(status_code=204)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/v1/review/{camera_id}/pending")
async def get_pending_reviews(
    camera_id: str,
    claims: dict = Depends(require_jwt),
):
    """Returns pending review requests filtered by the caller's role."""
    role = claims.get("role", "viewer")
    if role not in ("admin", "operator"):
        raise HTTPException(403, "Insufficient role")

    ADMIN_TYPES    = {"stage_question", "zone_proposal"}
    OPERATOR_TYPES = {"absence_question", "front_rush_question"}

    def visible(req: dict) -> bool:
        rt = req.get("review_type", "")
        return (role == "admin" and rt in ADMIN_TYPES) or \
               (role == "operator" and rt in OPERATOR_TYPES)

    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        return {"pending": [r for r in pipeline._movement.review_queue.pending_requests() if visible(r)]}

    keys    = _redis.keys(f"kyro:review:{camera_id}:*")
    pending = []
    for key in keys:
        raw = _redis.get(key)
        if raw:
            try:
                r = json.loads(raw)
                if visible(r):
                    pending.append(r)
            except Exception:
                pass
    return {"pending": pending}


@router.get("/api/v1/review/{camera_id}/memory", response_model=list[MemoryEntry])
async def get_memory(
    camera_id: str,
    claims: dict = Depends(require_jwt_or_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Returns everything the system has learned about this camera's spatial layout."""
    cam_result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    cam = cam_result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, f"Camera '{camera_id}' not found")

    result = await db.execute(
        select(SpatialMemory).where(SpatialMemory.camera_id == cam.id)
                             .order_by(SpatialMemory.confirmation_count.desc())
    )
    return [
        MemoryEntry(
            region_key=m.region_key,
            cx=m.region_cx,
            cy=m.region_cy,
            classification=m.classification,
            confirmation_count=m.confirmation_count,
            auto_zone_created=m.auto_zone_created,
        )
        for m in result.scalars().all()
    ]


@router.delete("/api/v1/review/{camera_id}/memory/{region_key}", status_code=204)
async def forget_region(
    camera_id: str,
    region_key: str,
    claims: dict = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin can delete a specific learned region (e.g. if the venue changes layout)."""
    cam_result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    cam = cam_result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, f"Camera '{camera_id}' not found")

    result = await db.execute(
        select(SpatialMemory).where(
            SpatialMemory.camera_id == cam.id,
            SpatialMemory.region_key == region_key,
        )
    )
    mem = result.scalar_one_or_none()
    if not mem:
        raise HTTPException(404, f"Memory region '{region_key}' not found")

    await db.delete(mem)
    await db.commit()

    # Reload pipeline memory
    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        await _reload_pipeline_memory(camera_id, cam.id, db, pipeline)


# ─── Startup loader — called by worker ───────────────────────────────────────

async def load_spatial_memory(camera_db_id: int, db: AsyncSession) -> list[dict]:
    """
    Load all learned spatial memory for a camera.
    Called by worker on startup to pre-populate ReviewQueue.
    Returns list of dicts matching LearnedRegion fields.
    """
    result = await db.execute(
        select(SpatialMemory).where(SpatialMemory.camera_id == camera_db_id)
    )
    return [
        {
            "region_key":         m.region_key,
            "cx":                 m.region_cx,
            "cy":                 m.region_cy,
            "classification":     m.classification,
            "confirmation_count": m.confirmation_count,
            "auto_zone_created":  m.auto_zone_created,
        }
        for m in result.scalars().all()
    ]


# ─── Helpers ─────────────────────────────────────────────────────────────────

ZONE_THRESHOLD = 3


async def _persist_memory_item(
    item: dict,
    cam: Camera,
    db: AsyncSession,
    camera_id: str,
) -> tuple[bool, Optional[str]]:
    """
    Upsert a learned region into SpatialMemory.
    If threshold reached and classification==stage_move, auto-creates an ExclusionZone.
    Returns (zone_created, zone_id).
    """
    result = await db.execute(
        select(SpatialMemory).where(
            SpatialMemory.camera_id == cam.id,
            SpatialMemory.region_key == item["region_key"],
        )
    )
    mem = result.scalar_one_or_none()

    if mem:
        if mem.classification == item["classification"]:
            mem.confirmation_count += 1
        else:
            # Different classification for same region — overwrite if more confident
            mem.classification     = item["classification"]
            mem.confirmation_count = 1
            mem.auto_zone_created  = False
    else:
        mem = SpatialMemory(
            camera_id=cam.id,
            region_key=item["region_key"],
            region_cx=item["cx"],
            region_cy=item["cy"],
            classification=item["classification"],
            confirmation_count=1,
            auto_zone_created=False,
        )
        db.add(mem)

    # Auto-create exclusion zone when threshold reached
    zone_created = False
    zone_id: Optional[str] = None

    if (
        mem.classification == "stage_move"
        and mem.confirmation_count >= ZONE_THRESHOLD
        and not mem.auto_zone_created
    ):
        zone_id = f"learned-{uuid4().hex[:8]}"
        bbox = item.get("suggested_bbox") or [
            item["cx"] - 96, item["cy"] - 96,
            item["cx"] + 96, item["cy"] + 96,
        ]
        db_zone = DBZone(
            camera_id=cam.id,
            zone_id=zone_id,
            label=f"Auto: learned stage area ({mem.region_key})",
            zone_type="hold_seats",  # a learned stage/front-rush area always holds seats
            bbox=bbox,
            hold_seats_in_rows=[],
            is_active=True,
        )
        db.add(db_zone)
        mem.auto_zone_created = True
        zone_created = True

        logger.info(
            "Auto-created exclusion zone | camera=%s zone=%s region=%s confirmations=%d",
            camera_id, zone_id, mem.region_key, mem.confirmation_count,
        )

        # Notify dashboard via Redis
        _redis.publish(
            f"kyro:camera:{camera_id}",
            json.dumps({
                "type":    "zone_auto_created",
                "camera_id": camera_id,
                "zone_id": zone_id,
                "label":   db_zone.label,
                "bbox":    bbox,
                "message": "The system has learned this area is the stage and will no longer ask about it.",
            }),
        )

    return zone_created, zone_id


async def _reload_pipeline_memory(
    camera_id: str,
    cam_db_id: int,
    db: AsyncSession,
    pipeline,
) -> None:
    """Reload spatial memory and exclusion zones into a running pipeline."""
    from ai.seat_detection.zones import ExclusionZone

    # Reload memory into ReviewQueue
    memory = await load_spatial_memory(cam_db_id, db)
    pipeline._movement.review_queue.load_memory(memory)

    # Reload exclusion zones
    zones_result = await db.execute(
        select(DBZone).where(DBZone.camera_id == cam_db_id, DBZone.is_active == True)
    )
    zones = [
        ExclusionZone(
            zone_id=z.zone_id,
            bbox=np.array(z.bbox, dtype=np.float32),
            label=z.label or "",
            zone_type=z.zone_type or "hold_seats",
            hold_seats_in_rows=z.hold_seats_in_rows or [],
        )
        for z in zones_result.scalars().all()
    ]
    pipeline._seat_engine.set_exclusion_zones(zones)
    pipeline._movement.update_stage_zones([z.bbox for z in zones if z.holds_seats])

    logger.info(
        "Pipeline memory reloaded | camera=%s memory_regions=%d zones=%d",
        camera_id, len(memory), len(zones),
    )


def _answer_to_movement(answer: str) -> str:
    return {
        "yes":         "stage_move",
        "stage":       "stage_move",
        "no":          "seated",
        "toilet":      "absence",
        "left":        "exit",
        "ignore":      "absence",
        "create_zone": "stage_move",
    }.get(answer, "absence")
