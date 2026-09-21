"""
Kyro — Alert Watcher

Background task that watches Redis health keys for all registered cameras
every 10 seconds. It is the single producer of alert events: it writes every
alert into the shared alert_store feed AND fires the matching Web Push.

Fires on:
  - Occupancy crossing warn/critical thresholds (debounced — once per crossing)
  - A camera that was running going offline (or reporting a blank/frozen feed)
  - A camera that was offline COMING BACK — recovery is a first-class event,
    not the absence of one. Previously nothing was emitted when a camera
    recovered, so the dashboard could only ever accumulate bad news: a camera
    that dropped for 30 seconds at 2am left a permanent "Camera Offline" entry
    with no corresponding "back online" to close it out.

Transition state lives in alert_store (Redis-backed), not a local dict, so it
is shared across uvicorn workers and survives a restart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Optional

import redis
from sqlalchemy import select

from backend.services import alert_store

logger = logging.getLogger(__name__)

POLL_INTERVAL = 10  # seconds between checks


def _format_downtime(since_iso: Optional[str]) -> str:
    """Human-readable gap between `since_iso` and now, e.g. '4m' or '2h 15m'."""
    if not since_iso:
        return ""
    try:
        from datetime import datetime, timezone as _tz
        since = datetime.fromisoformat(since_iso)
        if since.tzinfo is None:
            since = since.replace(tzinfo=_tz.utc)
        secs = int((datetime.now(_tz.utc) - since).total_seconds())
    except Exception:
        return ""
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m"
    hours, mins = divmod(mins, 60)
    if hours < 24:
        return f"{hours}h {mins}m" if mins else f"{hours}h"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours}h" if hours else f"{days}d"

_redis = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=True,
)


@dataclass
class _ZoneState:
    """Threshold debounce state per camera (occupancy only).

    Online/offline state deliberately does NOT live here — it lives in
    alert_store so every process agrees on it. Threshold debounce is safe to
    keep local because the worst case is a duplicate capacity push after a
    restart, whereas a missed recovery event is invisible to the user forever.
    """
    last_warn_fired:  bool = False
    last_crit_fired:  bool = False


_zone_states: dict[str, _ZoneState] = {}


def _get_health(camera_id: str) -> Optional[dict]:
    """
    Returns the parsed health heartbeat, or None if the camera has no heartbeat
    at all (worker not running / crashed — the key has a 10s TTL).
    """
    raw = _redis.get(f"kyro:health:{camera_id}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _read_camera(camera_id: str) -> tuple[str, int, int, Optional[str]]:
    """
    Resolve a camera's true status, checking both places a camera can be alive.

    Returns (status, current, capacity, error_reason) where status is
    "online" or "offline".

    Two sources, because a camera can be running in either of two ways and
    checking only one is how the dashboard ended up reporting every camera as
    permanently offline:
      1. Redis heartbeat — the normal path, written by the external ai/worker
         process. Anything driven by `ai/worker.py` only ever shows up here.
      2. In-process pipeline registry — cameras started inside the backend
         process itself.

    A heartbeat whose status is "error" (blank or frozen frames — a dead
    sensor or unplugged cable that the driver hasn't admitted to) counts as
    offline, since the feed is useless even though the process is alive.
    """
    health = _get_health(camera_id)
    if health:
        status = health.get("status", "online")
        if status == "error":
            return "offline", 0, int(health.get("capacity", 0) or 0), health.get("error_reason")
        return (
            "online",
            int(health.get("current", 0) or 0),
            int(health.get("capacity", 0) or 0),
            None,
        )

    # Fall back to an in-process pipeline before concluding "offline"
    try:
        from backend.services.pipeline_registry import pipeline_registry
        pipeline = pipeline_registry.get(camera_id)
        if pipeline:
            snap = pipeline._counter.snapshot()
            cap  = getattr(pipeline._counter, "_venue_capacity", 0) or 0
            return "online", snap.current_attendance, cap, None
    except Exception:
        pass

    return "offline", 0, 0, None


async def _fire_push_for_zone(
    camera_id: str,
    zone_name: str,
    current: int,
    capacity: int,
    pct: float,
    level: str,  # "warning" | "critical" | "offline" | "online"
    detail: str = "",
) -> None:
    """Look up all active rules matching this camera and fire pushes."""
    try:
        from backend.database.connection import AsyncSessionLocal
        from backend.database.push_models import PushSubscription, NotificationRule
        from backend.services.push_sender import send_push

        title = {
            "warning":  f"⚠️  {zone_name} filling up",
            "critical": f"🚨 {zone_name} — overcrowded!",
            "offline":  f"📵 {zone_name} camera offline",
            "online":   f"✅ {zone_name} camera back online",
        }.get(level, "Kyro Alert")

        body = {
            "warning":  f"{current} people · {int(pct)}% of {capacity} seats",
            "critical": f"Only {max(0, capacity - current)} seats left · {int(pct)}% full",
            "offline":  detail or "Camera stopped sending data.",
            "online":   detail or "Feed restored — counting resumed.",
        }.get(level, "")

        payload = {
            "title":     title,
            "body":      body,
            "tag":       f"kyro-{camera_id}-{level}",
            "camera_id": camera_id,
            "level":     level,
            "pct":       round(pct, 1),
        }

        async with AsyncSessionLocal() as db:
            # Find all rules that cover this camera
            result = await db.execute(
                select(NotificationRule, PushSubscription)
                .join(PushSubscription, NotificationRule.subscription_id == PushSubscription.id)
                .where(
                    NotificationRule.is_active == True,
                    PushSubscription.is_active == True,
                    (NotificationRule.camera_id == camera_id) |
                    (NotificationRule.camera_id == None),
                )
            )
            rows = result.all()

        for rule, sub in rows:
            # Respect per-rule thresholds
            threshold_ok = (
                level in ("offline", "online")
                or (level == "critical" and pct >= rule.crit_threshold * 100)
                or (level == "warning"  and pct >= rule.warn_threshold * 100)
            )
            if not threshold_ok:
                continue
            # Recovery rides on the same toggle as offline — they're two halves
            # of one lifecycle, so opting into "tell me when a camera drops"
            # implies "tell me when it comes back". Avoids a second column and
            # avoids the worse outcome of silent recoveries.
            if level in ("offline", "online") and not rule.notify_offline:
                continue

            # Fire in a thread pool so we don't block the event loop
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None, send_push, sub.endpoint, sub.p256dh, sub.auth, payload
            )
            logger.info("Push sent | level=%s camera=%s endpoint=...%s", level, camera_id, sub.endpoint[-20:])

    except Exception as exc:
        logger.error("alert_watcher push error: %s", exc)


async def _watch_loop() -> None:
    """Poll loop — runs forever in the background."""
    while True:
        try:
            from backend.database.connection import AsyncSessionLocal
            from backend.database.models import Camera

            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(Camera).where(Camera.is_active == True)
                )
                cameras = result.scalars().all()

            for cam in cameras:
                cid   = cam.camera_id
                zname = cam.zone_name or cam.name

                state = _zone_states.setdefault(cid, _ZoneState())
                status, current, live_cap, error_reason = _read_camera(cid)
                cap = live_cap or cam.zone_capacity or 0

                prev      = alert_store.get_camera_state(cid)
                prev_stat = prev.get("status") if prev else None

                # ── Transition handling ──────────────────────────────────
                if prev_stat is None:
                    # First observation (fresh start / new camera). Record a
                    # baseline silently — firing here would mean every backend
                    # restart spams an alert for every camera that happens to
                    # be down, which is noise, not news.
                    alert_store.set_camera_state(cid, status)

                elif status == "offline" and prev_stat == "online":
                    alert_store.set_camera_state(cid, "offline")
                    state.last_warn_fired = False
                    state.last_crit_fired = False
                    detail = error_reason or "Camera stopped sending data."
                    alert_store.record_event(
                        camera_id=cid, zone_name=zname, level="offline",
                        title="Camera Offline", message=detail,
                        venue_capacity=cap,
                    )
                    asyncio.create_task(
                        _fire_push_for_zone(cid, zname, 0, cap, 0.0, "offline", detail)
                    )

                elif status == "online" and prev_stat == "offline":
                    # Recovery. Compute how long it was down so the alert can
                    # say something useful instead of just "it's fine now".
                    downtime = _format_downtime(prev.get("since"))
                    alert_store.set_camera_state(cid, "online")
                    # Close out the stale offline entries for this camera
                    alert_store.resolve_events(cid, levels=("offline",))
                    detail = (
                        f"Feed restored after {downtime} — counting resumed."
                        if downtime else "Feed restored — counting resumed."
                    )
                    alert_store.record_event(
                        camera_id=cid, zone_name=zname, level="online",
                        title="Camera Back Online", message=detail,
                        current_attendance=current, venue_capacity=cap,
                    )
                    asyncio.create_task(
                        _fire_push_for_zone(cid, zname, current, cap, 0.0, "online", detail)
                    )

                if status == "offline":
                    continue

                pct = (current / cap * 100) if cap > 0 else 0.0

                # Critical crossing
                if pct >= 90.0 and not state.last_crit_fired:
                    state.last_crit_fired = True
                    alert_store.record_event(
                        camera_id=cid, zone_name=zname, level="critical",
                        title="High Density Detected",
                        message=f"{current}/{cap} ({pct:.0f}%)",
                        current_attendance=current, venue_capacity=cap, occupancy_percent=pct,
                    )
                    asyncio.create_task(_fire_push_for_zone(cid, zname, current, cap, pct, "critical"))
                elif pct < 85.0:  # reset so next crossing fires again
                    state.last_crit_fired = False

                # Warning crossing (only if not already critical)
                if pct >= 80.0 and pct < 90.0 and not state.last_warn_fired:
                    state.last_warn_fired = True
                    alert_store.record_event(
                        camera_id=cid, zone_name=zname, level="warning",
                        title="Approaching Capacity",
                        message=f"{current}/{cap} ({pct:.0f}%)",
                        current_attendance=current, venue_capacity=cap, occupancy_percent=pct,
                    )
                    asyncio.create_task(_fire_push_for_zone(cid, zname, current, cap, pct, "warning"))
                elif pct < 75.0:
                    state.last_warn_fired = False

        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.error("alert_watcher loop error: %s", exc)

        await asyncio.sleep(POLL_INTERVAL)


def start_alert_watcher() -> asyncio.Task:
    task = asyncio.create_task(_watch_loop())
    logger.info("Alert watcher started (poll every %ds)", POLL_INTERVAL)
    return task


# ---------------------------------------------------------------------------
# Demo alert simulator — fires fake pushes from demo camera data
# ---------------------------------------------------------------------------

DEMO_CAMERAS = [
    {"camera_id": "demo-main",     "zone_name": "Main Floor",       "capacity": 91},
    {"camera_id": "demo-balcony",  "zone_name": "Balcony",          "capacity": 60},
    {"camera_id": "demo-overflow", "zone_name": "Overflow Room",    "capacity": 50},
    {"camera_id": "demo-stadium",  "zone_name": "Stadium — Main Bowl", "capacity": 10000},
]

async def fire_demo_alerts() -> int:
    """
    Fires a sequence of realistic demo push notifications across the demo cameras.
    Returns the count of pushes fired.
    Designed to prove the full notification pipeline works without a real camera.
    """
    import random

    scenarios = [
        # (camera_idx, level, pct_override)
        (0, "warning",  82.0),   # Main Floor filling up
        (1, "critical", 93.0),   # Balcony overcrowded
        (2, "warning",  80.0),   # Overflow filling up
        (0, "critical", 91.0),   # Main Floor overcrowded
        (3, "warning",  81.0),   # Stadium filling up
    ]

    fired = 0
    for cam_idx, level, pct in scenarios:
        cam = DEMO_CAMERAS[cam_idx]
        current = int(cam["capacity"] * pct / 100)
        await _fire_push_for_zone(
            camera_id = cam["camera_id"],
            zone_name = cam["zone_name"],
            current   = current,
            capacity  = cam["capacity"],
            pct       = pct,
            level     = level,
        )
        fired += 1
        await asyncio.sleep(1.5)   # stagger so notifications don't collapse

    # Also fire a demo AI review request notification
    await _fire_review_push_demo()
    fired += 1

    logger.info("Demo alerts fired: %d", fired)
    return fired


async def _fire_review_push_demo() -> None:
    """Fire a demo push for an AI review question."""
    try:
        from backend.database.connection import AsyncSessionLocal
        from backend.database.push_models import PushSubscription, NotificationRule
        from backend.database.models import User
        from backend.services.push_sender import send_push
        from sqlalchemy import select

        payload = {
            "title":     "🎭 Kyro question — demo-main",
            "body":      "Someone moved toward the front — is this the stage or altar area? · Seat C5 (low confidence)",
            "tag":       "kyro-review-demo-1",
            "camera_id": "demo-main",
            "level":     "review",
        }

        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(NotificationRule, PushSubscription)
                .join(PushSubscription, NotificationRule.subscription_id == PushSubscription.id)
                .where(
                    NotificationRule.is_active == True,
                    PushSubscription.is_active == True,
                )
            )
            rows = result.all()

        loop = asyncio.get_event_loop()
        for rule, sub in rows:
            await loop.run_in_executor(None, send_push, sub.endpoint, sub.p256dh, sub.auth, payload)
            logger.info("Demo review push sent endpoint=...%s", sub.endpoint[-20:])

    except Exception as exc:
        logger.error("Demo review push error: %s", exc)
