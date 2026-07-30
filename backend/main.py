"""
Kyro — FastAPI Application Entry Point

Starts the REST API, WebSocket server, and Redis subscriber background task.
Routes:
  /api/v1/attendance/*   — Live metrics + session management
  /api/v1/seats/*        — Seat states + layout editor
  /api/v1/analytics/*    — Historical analytics + heatmaps
  /api/v1/cameras/*      — Camera CRUD + multi-camera management
  /api/v1/auth/*         — API key authentication
  /ws/{camera_id}        — Live WebSocket feed (JWT-protected)
Docs: http://localhost:8000/docs
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes.attendance import router as attendance_router
from backend.api.routes.seats import router as seats_router
from backend.api.routes.analytics import router as analytics_router
from backend.api.routes.cameras import router as cameras_router
from backend.api.routes.auth import router as auth_router
from backend.database.connection import create_tables
from backend.services.redis_subscriber import start_redis_subscriber
from backend.websockets.manager import manager
from backend.auth.dependencies import require_api_key

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

REDIS_URL: str = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

app = FastAPI(
    title="Kyro Vision API",
    description="AI-powered church attendance and smart seating intelligence",
    version="0.2.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS — allow dashboard dev server in development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(auth_router)
app.include_router(cameras_router)
app.include_router(attendance_router)
app.include_router(seats_router)
app.include_router(analytics_router)

# Store background task reference to prevent garbage collection
_subscriber_task = None


@app.on_event("startup")
async def startup() -> None:
    global _subscriber_task
    logger.info("Kyro backend starting up...")
    await create_tables()
    logger.info("Database tables ready")
    _subscriber_task = start_redis_subscriber(REDIS_URL)


@app.on_event("shutdown")
async def shutdown() -> None:
    global _subscriber_task
    if _subscriber_task:
        _subscriber_task.cancel()
    logger.info("Kyro backend shutting down")


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "kyro-backend",
        "version": "0.2.0",
        "websocket_connections": manager.total_connections,
    }


# ---------------------------------------------------------------------------
# WebSocket endpoint — live dashboard feed (API key via query param)
# ---------------------------------------------------------------------------

@app.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str, api_key: str = ""):
    """
    WebSocket feed for a specific camera.
    Pass ?api_key=<key> as query param for authentication.
    Workers push via Redis → subscriber → broadcast here.
    """
    # Validate API key from query string
    from backend.auth.dependencies import validate_api_key_value
    if not validate_api_key_value(api_key):
        await websocket.close(code=4001)
        return

    await manager.connect(websocket, camera_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, camera_id)
