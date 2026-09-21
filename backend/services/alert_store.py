"""
Kyro — Alert Event Store

A single, shared source of truth for alert *events* (things that happened at a
point in time), as opposed to alert *states* (what is true right now).

Why this exists
---------------
Before this, alerts were derived statelessly inside the /alerts endpoint on
every poll. That had three consequences the dashboard made painfully visible:

  1. "Camera Offline" re-appeared on every single poll with a *fresh*
     timestamp, so three cameras that went down at different times all showed
     the same time, and nothing ever aged out of the list.
  2. Recovery was invisible. A stateless snapshot can say "this camera is
     offline right now", but "this camera just came back" is a transition —
     it only exists if you remember what the previous state was.
  3. The transition memory that did exist was a module-level dict inside the
     API process. With more than one uvicorn worker, whichever worker served
     the poll had its own private idea of previous state, so recovery events
     were lost or double-fired at random. It also reset on every deploy.

Events live in Redis, so the alert watcher (producer) and every API worker
(consumer) all see the same feed, and it survives a backend restart. If Redis
is unavailable the store degrades to an in-process deque so local development
without Redis still works — it just loses cross-process sharing.

Keys
----
  kyro:alerts:feed       — capped list of JSON event objects, newest first
  kyro:alerts:camstate   — hash camera_id → JSON {status, since}
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import redis

logger = logging.getLogger(__name__)

FEED_KEY     = "kyro:alerts:feed"
CAMSTATE_KEY = "kyro:alerts:camstate"

# How many events to keep, and how long an event stays in the feed.
MAX_FEED_EVENTS  = 200
DEFAULT_MAX_AGE_HOURS = 24

_redis = redis.Redis(
    host=os.environ.get("REDIS_HOST", "localhost"),
    port=int(os.environ.get("REDIS_PORT", "6379")),
    decode_responses=True,
)

# Fallback used only when Redis is unreachable. Not shared across processes —
# this is a degraded mode, not the intended path.
_memory_feed: deque[str] = deque(maxlen=MAX_FEED_EVENTS)
_memory_camstate: dict[str, str] = {}
_redis_warned = False


def _redis_ok() -> bool:
    """True if Redis is reachable. Warns once rather than on every call."""
    global _redis_warned
    try:
        _redis.ping()
        _redis_warned = False
        return True
    except Exception as exc:
        if not _redis_warned:
            logger.warning("alert_store: Redis unavailable (%s) — using in-process fallback", exc)
            _redis_warned = True
        return False


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Camera state — used to detect transitions
# ---------------------------------------------------------------------------

def get_camera_state(camera_id: str) -> Optional[dict[str, Any]]:
    """
    Returns {"status": "online"|"offline"|"error", "since": iso} or None if we
    have never observed this camera (first run after a restart).

    None is meaningful: it tells the caller to establish a baseline WITHOUT
    firing a transition event, so a restart doesn't spam "camera offline" for
    cameras that have been quietly offline for a week.
    """
    raw = None
    if _redis_ok():
        try:
            raw = _redis.hget(CAMSTATE_KEY, camera_id)
        except Exception:
            raw = None
    if raw is None:
        raw = _memory_camstate.get(camera_id)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def set_camera_state(camera_id: str, status: str, since: Optional[str] = None) -> None:
    """Persist the current status. `since` is when this status began."""
    payload = json.dumps({"status": status, "since": since or _utcnow_iso()})
    _memory_camstate[camera_id] = payload
    if _redis_ok():
        try:
            _redis.hset(CAMSTATE_KEY, camera_id, payload)
        except Exception as exc:
            logger.debug("alert_store: hset failed: %s", exc)


def forget_camera(camera_id: str) -> None:
    """Drop all state for a camera — call when a camera is deleted."""
    _memory_camstate.pop(camera_id, None)
    if _redis_ok():
        try:
            _redis.hdel(CAMSTATE_KEY, camera_id)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

def record_event(
    *,
    camera_id: str,
    zone_name: str,
    level: str,              # critical | warning | offline | online | review
    title: str,
    message: str = "",
    current_attendance: int = 0,
    venue_capacity: int = 0,
    occupancy_percent: float = 0.0,
    triggered_at: Optional[str] = None,
) -> dict[str, Any]:
    """
    Append one event to the shared feed and return it.

    The timestamp is captured HERE, when the thing actually happened, and never
    recomputed on read — that's the whole point. An offline event that fired at
    14:02 still reads 14:02 an hour later.
    """
    event = {
        "id":                 uuid.uuid4().hex[:12],
        "camera_id":          camera_id,
        "zone_name":          zone_name,
        "level":              level,
        "title":              title,
        "message":            message,
        "current_attendance": int(current_attendance),
        "venue_capacity":     int(venue_capacity),
        "occupancy_percent":  round(float(occupancy_percent), 1),
        "triggered_at":       triggered_at or _utcnow_iso(),
        "resolved":           False,
        "resolved_at":        None,
    }
    raw = json.dumps(event)

    _memory_feed.appendleft(raw)
    if _redis_ok():
        try:
            pipe = _redis.pipeline()
            pipe.lpush(FEED_KEY, raw)
            pipe.ltrim(FEED_KEY, 0, MAX_FEED_EVENTS - 1)
            pipe.execute()
        except Exception as exc:
            logger.debug("alert_store: lpush failed: %s", exc)

    logger.info("Alert event | level=%s camera=%s %s", level, camera_id, title)
    return event


def _load_raw_feed() -> list[str]:
    if _redis_ok():
        try:
            return _redis.lrange(FEED_KEY, 0, MAX_FEED_EVENTS - 1)
        except Exception:
            pass
    return list(_memory_feed)


def _save_raw_feed(items: list[str]) -> None:
    _memory_feed.clear()
    _memory_feed.extend(items)
    if _redis_ok():
        try:
            pipe = _redis.pipeline()
            pipe.delete(FEED_KEY)
            if items:
                pipe.rpush(FEED_KEY, *items)
            pipe.execute()
        except Exception as exc:
            logger.debug("alert_store: feed rewrite failed: %s", exc)


def resolve_events(camera_id: str, levels: tuple[str, ...] = ("offline",)) -> int:
    """
    Mark a camera's outstanding events of the given levels as resolved.

    Called when a camera recovers: the historical "went offline at 14:02" entry
    stays in the feed (it did happen, and the timeline matters), but it's
    flagged so the UI can grey it out instead of showing a dead camera warning
    for a camera that is currently streaming fine.
    """
    items = _load_raw_feed()
    changed = 0
    out: list[str] = []
    now = _utcnow_iso()
    for raw in items:
        try:
            ev = json.loads(raw)
        except Exception:
            out.append(raw)
            continue
        if ev.get("camera_id") == camera_id and ev.get("level") in levels and not ev.get("resolved"):
            ev["resolved"]    = True
            ev["resolved_at"] = now
            changed += 1
            out.append(json.dumps(ev))
        else:
            out.append(raw)
    if changed:
        _save_raw_feed(out)
    return changed


def get_events(
    limit: int = 50,
    max_age_hours: int = DEFAULT_MAX_AGE_HOURS,
    include_resolved: bool = True,
) -> list[dict[str, Any]]:
    """
    Return recent events, newest first, dropping anything older than
    `max_age_hours` so the panel doesn't accumulate stale noise forever.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    events: list[dict[str, Any]] = []

    for raw in _load_raw_feed():
        try:
            ev = json.loads(raw)
        except Exception:
            continue
        if not include_resolved and ev.get("resolved"):
            continue
        try:
            ts = datetime.fromisoformat(ev["triggered_at"])
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                continue
        except Exception:
            pass
        events.append(ev)

    events.sort(key=lambda e: e.get("triggered_at", ""), reverse=True)
    return events[:limit]


def clear_feed() -> None:
    """Wipe the feed — used by 'mark all read' style actions and tests."""
    _memory_feed.clear()
    if _redis_ok():
        try:
            _redis.delete(FEED_KEY)
        except Exception:
            pass
