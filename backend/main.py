"""
Kyro — FastAPI Application Entry Point

Starts the REST API and WebSocket server.
Routes: /api/v1/attendance, /api/v1/seats, /ws/{camera_id}
Docs:   http://localhost:8000/docs
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes.attendance import router as attendance_router
from backend.api.routes.seats import router as seats_router
from backend.database.connection import create_tables
from backend.websockets.manager import manager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Kyro Vision API",
    description="AI-powered church attendance and smart seating intelligence",
    version="0.1.0",
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
app.include_router(attendance_router)
app.include_router(seats_router)


@app.on_event("startup")
async def startup() -> None:
    logger.info("Kyro backend starting up...")
    await create_tables()
    logger.info("Database tables ready")


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "kyro-backend"}


# ---------------------------------------------------------------------------
# WebSocket endpoint — live dashboard feed
# ---------------------------------------------------------------------------

@app.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    """
    WebSocket endpoint for the usher dashboard.
    Clients subscribe to a camera_id and receive live PipelineResult updates.
    """
    await manager.connect(websocket, camera_id)
    logger.info("Dashboard connected | camera=%s", camera_id)
    try:
        while True:
            # Keep connection alive; pipeline workers push data via manager.broadcast()
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, camera_id)
        logger.info("Dashboard disconnected | camera=%s", camera_id)
