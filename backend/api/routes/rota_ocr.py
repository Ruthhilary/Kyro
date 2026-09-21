"""
Kyro — Rota Photo OCR (optional, paid path)

POST /api/v1/rota/{camera_id}/upload-photo

Accepts a photo of a paper/whiteboard rota, sends it to Claude Vision,
and extracts structured rota entries (who, what rows/seats, what time).
Returns the parsed entries for the user to confirm before saving.

NOTE: the dashboard's Rota page does NOT call this endpoint by default —
it reads the photo entirely in the browser with tesseract.js (free, no
API key, nothing leaves the device) via dashboard/src/lib/rotaParser.ts,
and asks the user directly for any seating area it can't work out on its
own. This route is kept as an optional higher-accuracy path for anyone
who has set ANTHROPIC_API_KEY and wants to wire the dashboard up to it;
it requires that env var and will error clearly if it's missing.

POST /api/v1/rota/{camera_id}/confirm-photo
Saves the confirmed parsed entries into the DB and hot-applies to pipeline.
This one has no AI dependency — it's used by both paths.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone, date
from typing import Optional
from uuid import uuid4

import anthropic
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth.dependencies import require_admin_or_operator
from backend.database.connection import get_db
from backend.database.models import Camera, RotaEntry as DBRota
from backend.services.pipeline_registry import pipeline_registry
from ai.seat_detection.rota import RotaEntry
from sqlalchemy import select

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Rota OCR"])

# Claude client — uses ANTHROPIC_API_KEY from environment
_client: Optional[anthropic.Anthropic] = None

def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise HTTPException(500, "ANTHROPIC_API_KEY not set — cannot parse rota photos")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


# ─── Schemas ─────────────────────────────────────────────────────────────────

class ParsedRotaEntry(BaseModel):
    """One entry extracted from the photo."""
    label: str                         # e.g. "Choir", "Pastor John", "Welcome Team"
    start_time: str                    # ISO datetime string, e.g. "2026-08-03T10:00:00"
    end_time: str                      # ISO datetime string
    rows: list[str] = []               # e.g. ["A", "B", "C"]
    seat_ids: list[str] = []           # specific seat IDs if mentioned
    section: Optional[str] = None
    confidence: str = "high"           # high / medium / low — how sure the AI is
    note: Optional[str] = None         # any clarification needed from user


class RotaPhotoResponse(BaseModel):
    entries: list[ParsedRotaEntry]
    raw_text: str                      # what the AI read from the image
    warnings: list[str]               # things it wasn't sure about


class ConfirmRotaRequest(BaseModel):
    entries: list[ParsedRotaEntry]
    service_date: str                  # "2026-08-03" — base date for relative times


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.post("/api/v1/rota/{camera_id}/upload-photo", response_model=RotaPhotoResponse)
async def upload_rota_photo(
    camera_id: str,
    photo: UploadFile = File(...),
    _: dict = Depends(require_admin_or_operator),
    db: AsyncSession = Depends(get_db),
):
    """
    Upload a photo of a paper rota. Returns parsed entries for review.
    The user confirms/edits before saving.
    """
    # Validate camera exists
    result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    if not result.scalar_one_or_none():
        raise HTTPException(404, f"Camera '{camera_id}' not found")

    # Read image
    content_type = photo.content_type or "image/jpeg"
    if not content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image (jpeg, png, webp)")

    image_bytes = await photo.read()
    if len(image_bytes) > 10 * 1024 * 1024:   # 10MB limit
        raise HTTPException(400, "Image too large — maximum 10MB")

    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    media_type = content_type  # "image/jpeg" etc.

    # Send to Claude Vision
    client = _get_client()
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    prompt = f"""You are parsing a church service rota (schedule/programme) from a photo.
Today's date is {today_str}.

Extract ALL scheduled appearances, including:
- Choir / worship team (which rows they sit in, when they go on stage)
- Specific people (pastor, speaker, welcome team, etc.)
- Any groups going to the front or on stage

For each entry, output a JSON object with these fields:
- label: who/what group (string)
- start_time: when they go on stage in ISO format "YYYY-MM-DDTHH:MM:00" (use today's date if only time given)
- end_time: when they return to their seat in ISO format
- rows: list of seating row letters they sit in, e.g. ["A","B","C"] (empty if unknown)
- seat_ids: specific seat IDs if mentioned, e.g. ["D7"] (empty if unknown)
- section: section name if mentioned e.g. "Choir" (null if not)
- confidence: "high" if clear, "medium" if estimated, "low" if guessed
- note: any uncertainty or assumption you made (null if none)

Return ONLY a JSON object with:
{{
  "raw_text": "verbatim text you read from the image",
  "entries": [ ...list of entry objects... ],
  "warnings": [ ...list of things you were unsure about... ]
}}

If you cannot read the image or it is not a rota, return:
{{
  "raw_text": "",
  "entries": [],
  "warnings": ["Could not parse rota from this image"]
}}"""

    try:
        message = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=2048,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }],
        )
    except anthropic.APIError as e:
        logger.error("Claude API error parsing rota: %s", e)
        raise HTTPException(502, f"Vision API error: {e}")

    # Parse Claude's response
    raw_response = message.content[0].text.strip()
    # Strip markdown code fences if present
    if raw_response.startswith("```"):
        raw_response = raw_response.split("```")[1]
        if raw_response.startswith("json"):
            raw_response = raw_response[4:]

    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError:
        logger.warning("Could not parse Claude rota response as JSON: %s", raw_response[:200])
        return RotaPhotoResponse(
            entries=[],
            raw_text=raw_response,
            warnings=["Could not extract structured data — please enter the rota manually"],
        )

    entries = [ParsedRotaEntry(**e) for e in parsed.get("entries", [])]
    return RotaPhotoResponse(
        entries=entries,
        raw_text=parsed.get("raw_text", ""),
        warnings=parsed.get("warnings", []),
    )


@router.post("/api/v1/rota/{camera_id}/confirm-photo", status_code=201)
async def confirm_rota_from_photo(
    camera_id: str,
    body: ConfirmRotaRequest,
    claims: dict = Depends(require_admin_or_operator),
    db: AsyncSession = Depends(get_db),
):
    """
    Save confirmed parsed rota entries to the DB and hot-apply to pipeline.
    The user reviews the parsed entries first, then POSTs here to confirm.
    """
    result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, f"Camera '{camera_id}' not found")

    saved: list[dict] = []
    rota_entries_for_pipeline: list[RotaEntry] = []

    for entry in body.entries:
        entry_id = f"rota-{uuid4().hex[:8]}"
        try:
            start_dt = datetime.fromisoformat(entry.start_time).replace(tzinfo=None)
            end_dt   = datetime.fromisoformat(entry.end_time).replace(tzinfo=None)
        except ValueError as e:
            raise HTTPException(400, f"Invalid datetime in entry '{entry.label}': {e}")

        db_entry = DBRota(
            camera_id=cam.id,
            entry_id=entry_id,
            label=entry.label,
            start_time=start_dt,
            end_time=end_dt,
            seat_ids=entry.seat_ids,
            rows=entry.rows,
            section=entry.section,
            is_active=True,
        )
        db.add(db_entry)

        rota_entries_for_pipeline.append(RotaEntry(
            entry_id=entry_id,
            label=entry.label,
            start_epoch=start_dt.replace(tzinfo=timezone.utc).timestamp(),
            end_epoch=end_dt.replace(tzinfo=timezone.utc).timestamp(),
            seat_ids=entry.seat_ids,
            rows=entry.rows,
            section=entry.section,
        ))
        saved.append({"entry_id": entry_id, "label": entry.label})

    await db.commit()

    # Hot-apply to running pipeline
    pipeline = pipeline_registry.get(camera_id)
    if pipeline:
        for entry in rota_entries_for_pipeline:
            pipeline._seat_engine.rota.add(entry)

    logger.info("Rota confirmed from photo | camera=%s entries=%d", camera_id, len(saved))
    return {"saved": len(saved), "entries": saved}
