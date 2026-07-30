"""
Kyro — Redis Subscriber

Runs as a background asyncio task inside the FastAPI process.
Subscribes to all kyro:camera:* Redis channels and forwards
every published JSON payload to the WebSocket ConnectionManager
so all connected dashboard clients receive live updates.

Design decisions:
- One asyncio task per camera channel, spawned lazily on first worker publish.
- Uses redis-py async client (redis.asyncio) — no blocking calls in the event loop.
- Reconnects automatically if Redis drops.
"""

from __future__ import annotations

import asyncio
import json
import logging

import redis.asyncio as aioredis

from backend.websockets.manager import manager

logger = logging.getLogger(__name__)

# Pattern that matches all camera channels
CHANNEL_PATTERN = "kyro:camera:*"


async def _subscribe_loop(redis_url: str) -> None:
    """Long-running coroutine: listen to all camera channels and broadcast."""
    while True:
        try:
            client = aioredis.from_url(redis_url, decode_responses=True)
            pubsub = client.pubsub()
            await pubsub.psubscribe(CHANNEL_PATTERN)
            logger.info("Redis subscriber listening on pattern: %s", CHANNEL_PATTERN)

            async for raw_msg in pubsub.listen():
                # raw_msg types: "psubscribe" (ack) or "pmessage" (data)
                if raw_msg.get("type") != "pmessage":
                    continue

                channel: str = raw_msg.get("channel", "")
                # channel format: "kyro:camera:<camera_id>"
                parts = channel.split(":", 2)
                if len(parts) != 3:
                    continue
                camera_id = parts[2]

                try:
                    payload = json.loads(raw_msg["data"])
                except (json.JSONDecodeError, KeyError):
                    logger.warning("Malformed Redis message on channel %s", channel)
                    continue

                await manager.broadcast(camera_id, payload)

        except asyncio.CancelledError:
            logger.info("Redis subscriber cancelled")
            return
        except Exception as exc:
            logger.error("Redis subscriber error: %s — reconnecting in 3s", exc)
            await asyncio.sleep(3)


def start_redis_subscriber(redis_url: str) -> asyncio.Task:
    """
    Spawn the subscriber loop as a background asyncio task.
    Call this once from the FastAPI startup event.
    """
    task = asyncio.create_task(_subscribe_loop(redis_url))
    logger.info("Redis subscriber task started")
    return task
