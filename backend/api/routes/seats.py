"""
Kyro — Seat API Routes

GET  /api/v1/seats/{camera_id}            — Live seat states
GET  /api/v1/seats/{camera_id}/available  — Available seats only (usher view)
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from backend.services.pipeline_registry import pipeline_registry

router = APIRouter(prefix="/api/v1/seats", tags=["Seats"])


class SeatState(BaseModel):
    seat_id: str
    row: str
    number: int
    section: str
    state: str
    confidence: float
    occupying_track_id: Optional[int]
    bbox: list[float]


@router.get("/{camera_id}", response_model=list[SeatState])
async def get_seat_states(camera_id: str):
    """Return full seat occupancy state for a camera."""
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(status_code=404, detail=f"Camera '{camera_id}' not found")

    return [SeatState(**s) for s in pipeline._seat_engine.occupancy_summary and
            [seat.to_dict() for seat in pipeline._seat_engine.seats]]


@router.get("/{camera_id}/available", response_model=list[SeatState])
async def get_available_seats(camera_id: str):
    """Return only available seats — for usher dashboard."""
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(status_code=404, detail=f"Camera '{camera_id}' not found")

    available = [
        seat.to_dict()
        for seat in pipeline._seat_engine.seats
        if seat.is_available_for_usher
    ]
    return [SeatState(**s) for s in available]


@router.get("/{camera_id}/summary")
async def get_seat_summary(camera_id: str):
    """Occupancy summary counts."""
    pipeline = pipeline_registry.get(camera_id)
    if not pipeline:
        raise HTTPException(status_code=404, detail=f"Camera '{camera_id}' not found")
    return pipeline._seat_engine.occupancy_summary
