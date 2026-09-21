"""
Kyro — WebSocket Connection Manager

Manages all active dashboard WebSocket connections.
Broadcasts live pipeline results to all connected dashboards.

Design decisions:
- Connections grouped by camera_id so clients can subscribe to a specific feed.
- Broadcast is fire-and-forget; failed sends remove the connection silently.
- Thread-safe via asyncio — no explicit locks needed in single-process setup.
"""

from __future__ import annotations

import logging
from collections import defaultdict

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections per camera feed."""

    def __init__(self) -> None:
        # camera_id → list of active WebSocket connections
        self._connections: dict[str, list[WebSocket]] = defaultdict(list)

    async def connect(self, websocket: WebSocket, camera_id: str) -> None:
        await websocket.accept()
        self._connections[camera_id].append(websocket)
        logger.info("WS connected | camera=%s total=%d", camera_id, len(self._connections[camera_id]))

    def disconnect(self, websocket: WebSocket, camera_id: str) -> None:
        conns = self._connections.get(camera_id, [])
        if websocket in conns:
            conns.remove(websocket)
        logger.info("WS disconnected | camera=%s remaining=%d", camera_id, len(conns))

    async def broadcast(self, camera_id: str, message: dict) -> None:
        """Send a JSON message to all clients subscribed to this camera."""
        dead: list[WebSocket] = []
        for ws in list(self._connections.get(camera_id, [])):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)

        for ws in dead:
            self.disconnect(ws, camera_id)

    async def broadcast_all(self, message: dict) -> None:
        """Broadcast to every connected client regardless of camera."""
        for camera_id in list(self._connections.keys()):
            await self.broadcast(camera_id, message)

    @property
    def total_connections(self) -> int:
        return sum(len(conns) for conns in self._connections.values())


# Global singleton — shared across FastAPI app
manager = ConnectionManager()
