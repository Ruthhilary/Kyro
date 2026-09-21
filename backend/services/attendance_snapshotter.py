"""
Kyro — Attendance Snapshotter

Background task that periodically writes an AttendanceEvent row for every
currently open session — every POLL_INTERVAL seconds, for as long as a
session is running.

WHY THIS EXISTS: the AttendanceEvent model's own docstring says "Periodic
attendance snapshot (flushed every N seconds)" — but until now, nothing
actually did that periodic flushing. AttendanceEvent rows were only ever
written in two places: once when a session ends (a single closing
snapshot), and via a manual /flush endpoint an admin would have to remember
to call. That meant there was almost no real intraday history in the
database — which is why "today"'s attendance chart, the analytics arrival-
pattern chart, and picking a specific past date all showed empty/flat/
misleading data: there was essentially nothing there to show. This task is
the actual fix — it makes sure real data exists to query in the first
place.

Reads live numbers from the same Redis health heartbeat the camera-status
endpoint and alert watcher already use, so this works whether the backend
and vision worker are in the same process or (the normal case) separate
containers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Optional

import redis
from sqlalchemy import select

logger = logging.getLogger(__name__)

POLL_INTERVAL = int(os.environ.get("ATTENDANCE_SNAPSHOT_INTERVAL_SECONDS", "120"))  # 2 min default

_redis = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=True,
)


def _get_live_snapshot(camera_id: str) -> Optional[dict]:
    """Returns the parsed health payload, or None if the camera has no heartbeat."""
    raw = _redis.get(f"kyro:health:{camera_id}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


async def _snapshot_loop() -> None:
    """Runs forever in the background, writing one AttendanceEvent per open session per interval."""
    while True:
        try:
            from backend.database.connection import AsyncSessionLocal
            from backend.database.models import Camera, Session as DBSession, AttendanceEvent

            async with AsyncSessionLocal() as db:
                # All open sessions, joined with their camera's string ID
                # (health keys are keyed by the string camera_id, not the
                # internal integer FK).
                result = await db.execute(
                    select(DBSession, Camera)
                    .join(Camera, DBSession.camera_id == Camera.id)
                    .where(DBSession.ended_at == None)
                )
                rows = result.all()

                written = 0
                for session, cam in rows:
                    live = _get_live_snapshot(cam.camera_id)
                    if live is None:
                        continue  # camera offline right now — nothing to snapshot

                    event = AttendanceEvent(
                        session_id=session.id,
                        recorded_at=datetime.utcnow(),
                        current_attendance=int(live.get("current", 0)),
                        total_entries=int(live.get("total_entries", session.total_entries or 0)),
                        total_exits=int(live.get("total_exits", session.total_exits or 0)),
                        occupancy_percent=float(live.get("occupancy_pct", 0.0)),
                    )
                    db.add(event)

                    # Keep the session's own running totals in sync too,
                    # so anything reading Session directly (not just
                    # AttendanceEvent history) stays accurate between
                    # explicit updates.
                    peak = int(live.get("peak", 0))
                    if peak > (session.peak_attendance or 0):
                        session.peak_attendance = peak
                    if "total_entries" in live:
                        session.total_entries = int(live["total_entries"])
                    if "total_exits" in live:
                        session.total_exits = int(live["total_exits"])

                    written += 1

                if written:
                    await db.commit()
                    logger.debug("Attendance snapshotter: wrote %d event(s)", written)

        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.error("Attendance snapshotter loop error: %s", exc)

        await asyncio.sleep(POLL_INTERVAL)


def start_attendance_snapshotter() -> asyncio.Task:
    task = asyncio.create_task(_snapshot_loop())
    logger.info("Attendance snapshotter started (every %ds)", POLL_INTERVAL)
    return task
