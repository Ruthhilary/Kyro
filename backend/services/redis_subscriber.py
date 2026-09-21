"""
Kyro — Redis Subscriber

Subscribes to:
- kyro:camera:*        — live frame data + review requests → broadcast to dashboard
- kyro:memory_persist:* — spatial memory from external workers → write to DB

Reconnects automatically if Redis drops.
"""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import uuid4

import redis.asyncio as aioredis

from backend.websockets.manager import manager

logger = logging.getLogger(__name__)

CHANNEL_PATTERN = "kyro:camera:*"
MEMORY_PATTERN  = "kyro:memory_persist:*"

# Lazy DB import to avoid circular deps at module load
_db_session_factory = None


def _get_db_factory():
    global _db_session_factory
    if _db_session_factory is None:
        from backend.database.connection import AsyncSessionLocal
        _db_session_factory = AsyncSessionLocal
    return _db_session_factory


async def _push_review_request(camera_id: str, payload: dict) -> None:
    """
    Fire a push notification when the AI raises a review question.
    Targets admin-role subscriptions for spatial questions,
    operator-role subscriptions for people questions.
    """
    try:
        from sqlalchemy import select
        from backend.database.push_models import PushSubscription, NotificationRule
        from backend.database.models import Camera, User
        from backend.services.push_sender import send_push

        review_type = payload.get("review_type", "")
        question    = payload.get("question", "AI needs your input")
        seat_id     = payload.get("seat_id", "")
        confidence  = payload.get("confidence", 1.0)

        # Route by type: spatial → admin, people → operator/admin
        is_spatial = review_type in ("stage_question", "zone_proposal")
        target_role = "admin" if is_spatial else None  # None = any subscribed user

        icon = "🎭" if is_spatial else "👤"
        conf_label = " (low confidence)" if confidence < 0.6 else ""

        push_title = f"{icon} Kyro question — {camera_id}"
        push_body  = f"{question}{conf_label}"
        if seat_id:
            push_body += f" · Seat {seat_id}"

        payload_out = {
            "title":     push_title,
            "body":      push_body,
            "tag":       f"kyro-review-{payload.get('review_id', camera_id)}",
            "camera_id": camera_id,
            "level":     "review",
            "review_id": payload.get("review_id"),
        }

        factory = _get_db_factory()
        async with factory() as db:
            # Get all active subscriptions
            result = await db.execute(
                select(NotificationRule, PushSubscription, User)
                .join(PushSubscription, NotificationRule.subscription_id == PushSubscription.id)
                .join(User, PushSubscription.user_id == User.id)
                .where(
                    NotificationRule.is_active == True,
                    PushSubscription.is_active == True,
                    (NotificationRule.camera_id == camera_id) |
                    (NotificationRule.camera_id == None),
                )
            )
            rows = result.all()

        loop = asyncio.get_event_loop()
        for rule, sub, user in rows:
            # For spatial questions only push to admins
            if is_spatial and user.role != "admin":
                continue
            await loop.run_in_executor(
                None, send_push, sub.endpoint, sub.p256dh, sub.auth, payload_out
            )
            logger.info(
                "Review push sent | type=%s camera=%s user=%s",
                review_type, camera_id, user.username,
            )

    except Exception as exc:
        logger.error("Review push error: %s", exc)


async def _persist_memory_from_worker(camera_id: str, item: dict) -> None:
    """
    Persist a spatial memory item sent from an external worker process.
    This is the DB write path for workers running as separate processes.
    """
    try:
        from sqlalchemy import select
        from backend.database.models import Camera, SpatialMemory, ExclusionZone as DBZone

        factory = _get_db_factory()
        async with factory() as db:
            cam_result = await db.execute(select(Camera).where(Camera.camera_id == camera_id))
            cam = cam_result.scalar_one_or_none()
            if not cam:
                return

            key = item.get("region_key")
            if not key:
                return

            result = await db.execute(
                select(SpatialMemory).where(
                    SpatialMemory.camera_id == cam.id,
                    SpatialMemory.region_key == key,
                )
            )
            mem = result.scalar_one_or_none()

            classification = item.get("classification", "absence")

            if mem:
                if mem.classification == classification:
                    mem.confirmation_count += 1
                else:
                    mem.classification     = classification
                    mem.confirmation_count = 1
                    mem.auto_zone_created  = False
            else:
                mem = SpatialMemory(
                    camera_id=cam.id,
                    region_key=key,
                    region_cx=item.get("cx", 0.0),
                    region_cy=item.get("cy", 0.0),
                    classification=classification,
                    confirmation_count=1,
                    auto_zone_created=False,
                )
                db.add(mem)

            ZONE_THRESHOLD = 3
            zone_created   = False
            zone_id: str | None = None

            if (
                classification == "stage_move"
                and mem.confirmation_count >= ZONE_THRESHOLD
                and not mem.auto_zone_created
            ):
                zone_id = f"learned-{uuid4().hex[:8]}"
                bbox    = item.get("suggested_bbox") or [
                    item.get("cx", 0) - 96, item.get("cy", 0) - 96,
                    item.get("cx", 0) + 96, item.get("cy", 0) + 96,
                ]
                db_zone = DBZone(
                    camera_id=cam.id,
                    zone_id=zone_id,
                    label=f"Auto: learned stage area ({key})",
                    bbox=bbox,
                    hold_seats_in_rows=[],
                    is_active=True,
                )
                db.add(db_zone)
                mem.auto_zone_created = True
                zone_created = True
                logger.info(
                    "Auto-created zone from worker memory | camera=%s zone=%s region=%s",
                    camera_id, zone_id, key,
                )

            await db.commit()

            # Notify dashboard of auto-created zone
            if zone_created and zone_id:
                await manager.broadcast(camera_id, {
                    "type":    "zone_auto_created",
                    "camera_id": camera_id,
                    "zone_id": zone_id,
                    "label":   f"Auto: learned stage area ({key})",
                    "bbox":    bbox,
                    "message": "The system has learned this area is the stage and will no longer ask about it.",
                })

    except Exception as exc:
        logger.error("Memory persistence error for camera %s: %s", camera_id, exc)


async def _subscribe_loop(redis_url: str) -> None:
    """Long-running coroutine: subscribe and dispatch all Redis messages."""
    while True:
        try:
            client = aioredis.from_url(redis_url, decode_responses=True)
            pubsub = client.pubsub()
            await pubsub.psubscribe(CHANNEL_PATTERN, MEMORY_PATTERN)
            logger.info(
                "Redis subscriber listening | patterns=%s, %s",
                CHANNEL_PATTERN, MEMORY_PATTERN,
            )

            async for raw_msg in pubsub.listen():
                if raw_msg.get("type") != "pmessage":
                    continue

                channel: str = raw_msg.get("channel", "")

                try:
                    payload = json.loads(raw_msg["data"])
                except (json.JSONDecodeError, KeyError):
                    logger.warning("Malformed Redis message on %s", channel)
                    continue

                # Memory persistence path (from external worker)
                if channel.startswith("kyro:memory_persist:"):
                    parts = channel.split(":", 2)
                    if len(parts) == 3:
                        asyncio.create_task(_persist_memory_from_worker(parts[2], payload))
                    continue

                # Camera channel → broadcast to dashboard WebSocket clients
                parts = channel.split(":", 2)
                if len(parts) == 3:
                    camera_id = parts[2]
                    await manager.broadcast(camera_id, payload)

                    # Fire a push notification for review requests so admins/operators
                    # get notified even when the tab is closed
                    if payload.get("type") == "review_request":
                        asyncio.create_task(_push_review_request(camera_id, payload))

        except asyncio.CancelledError:
            logger.info("Redis subscriber cancelled")
            return
        except Exception as exc:
            logger.error("Redis subscriber error: %s — reconnecting in 3s", exc)
            await asyncio.sleep(3)


def start_redis_subscriber(redis_url: str) -> asyncio.Task:
    task = asyncio.create_task(_subscribe_loop(redis_url))
    logger.info("Redis subscriber task started")
    return task
