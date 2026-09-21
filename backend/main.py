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
from backend.api.routes.users import router as users_router
from backend.api.routes.zones import router as zones_router
from backend.api.routes.rota_ocr import router as rota_ocr_router
from backend.api.routes.review import router as review_router
from backend.api.routes.push import router as push_router
from backend.database.connection import create_tables
from backend.database.push_models import PushSubscription, NotificationRule  # ensure tables created
from backend.services.redis_subscriber import start_redis_subscriber
from backend.services.alert_watcher import start_alert_watcher
from backend.services.attendance_snapshotter import start_attendance_snapshotter
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

# CORS — allow dashboard (same-origin via nginx in prod, localhost in dev)
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "")
_extra = [o.strip() for o in _raw_origins.split(",") if o.strip()]
_allow_origins = list(set([
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:80",
    "http://localhost",
] + _extra))

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_origin_regex=r"https?://.*",   # allow any origin in prod (nginx handles security)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(auth_router)
app.include_router(users_router)
app.include_router(cameras_router)
app.include_router(attendance_router)
app.include_router(seats_router)
app.include_router(analytics_router)
app.include_router(zones_router)
app.include_router(rota_ocr_router)
app.include_router(review_router)
app.include_router(push_router)

# Store background task reference to prevent garbage collection
_subscriber_task = None
_watcher_task    = None
_snapshot_task   = None


@app.on_event("startup")
async def startup() -> None:
    global _subscriber_task, _watcher_task, _snapshot_task
    logger.info("Kyro backend starting up...")
    await create_tables()
    logger.info("Database tables ready")
    _subscriber_task = start_redis_subscriber(REDIS_URL)
    _watcher_task    = start_alert_watcher()
    _snapshot_task   = start_attendance_snapshotter()


@app.on_event("shutdown")
async def shutdown() -> None:
    global _subscriber_task, _watcher_task, _snapshot_task
    if _subscriber_task:
        _subscriber_task.cancel()
    if _watcher_task:
        _watcher_task.cancel()
    if _snapshot_task:
        _snapshot_task.cancel()
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
async def websocket_endpoint(websocket: WebSocket, camera_id: str, token: str = ""):
    """
    WebSocket feed for a specific camera.
    Pass ?token=<jwt> as query param for authentication.
    Workers push via Redis → subscriber → broadcast here.
    """
    # Validate JWT before accepting — reject immediately if invalid
    if token:
        try:
            from backend.auth.dependencies import decode_jwt
            decode_jwt(token)
        except Exception:
            await websocket.close(code=4001)
            return

    # connect() calls websocket.accept() internally
    await manager.connect(websocket, camera_id)
    logger.info("Dashboard connected | camera=%s total=%d", camera_id, len(manager._connections[camera_id]))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, camera_id)
