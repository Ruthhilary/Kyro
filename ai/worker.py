"""
Kyro — Vision Worker

Entry point for the AI inference process.
Reads frames from a camera stream, runs the VisionPipeline,
and publishes results to Redis for the backend to broadcast.

Supports:
- CPU and GPU inference (DETECTION_DEVICE=cpu|cuda|mps)
- RTSP, MJPEG, and local camera streams
- Auto-reconnect on stream failure
- Redis pub/sub for live results → backend → WebSocket
- Redis health heartbeat so the backend can report camera status
- Seat layout loading from backend API on startup
- Multiple workers can run simultaneously (one per camera)

Run:
    python -m ai.worker --camera-id cam-01 --stream 0
    python -m ai.worker --camera-id cam-01 --stream rtsp://192.168.1.10/stream
    python -m ai.worker --camera-id cam-02 --stream 0 --capacity 300 --layout-id 1
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from typing import Optional

import cv2
import httpx
import numpy as np
import redis

from ai.config import config
from ai.pipeline import VisionPipeline
from ai.seat_detection.seat import Seat

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("kyro.worker")

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Kyro Vision Worker")
    p.add_argument("--camera-id",  default="cam-01", help="Unique camera identifier")
    p.add_argument("--stream",     default="0",      help="Stream source (device index or URL)")
    p.add_argument("--capacity",   type=int, default=0, help="Venue seat capacity")
    p.add_argument("--layout-id",  type=int, default=None, help="Seat layout DB id to load on startup")
    p.add_argument("--api-key",    default=None,     help="Backend API key for layout loading")
    p.add_argument("--backend-url", default="http://localhost:8000", help="Backend base URL")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Camera open with retry
# ---------------------------------------------------------------------------

def open_capture(stream: str) -> cv2.VideoCapture:
    source: int | str = int(stream) if stream.isdigit() else stream
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open stream: {stream}")
    logger.info("Camera stream opened | source=%s", stream)
    return cap


# ---------------------------------------------------------------------------
# Seat layout loading
# ---------------------------------------------------------------------------

def load_seats_from_api(
    camera_id: str,
    layout_id: int,
    backend_url: str,
    api_key: str,
) -> list[Seat]:
    """
    Fetch a saved seat layout from the backend REST API.
    Falls back to demo seats on any failure.
    """
    url = f"{backend_url}/api/v1/seats/{camera_id}/layouts/{layout_id}"
    try:
        resp = httpx.get(url, headers={"X-API-Key": api_key}, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        seats = [
            Seat(
                seat_id=s["seat_id"],
                bbox=np.array(s["bbox"], dtype=np.float32),
                row=s["row"],
                number=s["number"],
                section=s.get("section", "Main"),
            )
            for s in data["seats"]
        ]
        logger.info("Loaded %d seats from layout %d", len(seats), layout_id)
        return seats
    except Exception as exc:
        logger.warning("Could not load layout %d: %s — using demo seats", layout_id, exc)
        return build_demo_seats()


def build_demo_seats() -> list[Seat]:
    """
    4×5 grid of demo seats.
    Replace with a real seat map by using the layout editor.
    """
    seats: list[Seat] = []
    rows = ["A", "B", "C", "D"]
    seat_w, seat_h = 80, 80
    for r_idx, row in enumerate(rows):
        for c in range(1, 6):
            x1 = 100 + (c - 1) * 120
            y1 = 150 + r_idx * 110
            seats.append(Seat(
                seat_id=f"{row}-{c}",
                bbox=np.array([x1, y1, x1 + seat_w, y1 + seat_h], dtype=np.float32),
                row=row,
                number=c,
                section="Main Floor",
            ))
    return seats


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()

    # Redis client
    r = redis.Redis(
        host=config.redis.host,
        port=config.redis.port,
        db=config.redis.db,
        password=config.redis.password,
        decode_responses=True,
    )

    # Determine seats
    api_key = args.api_key or "kyro-dev-key-change-in-production"
    if args.layout_id is not None:
        seats = load_seats_from_api(args.camera_id, args.layout_id, args.backend_url, api_key)
    else:
        seats = build_demo_seats()

    # Build pipeline
    pipeline = VisionPipeline(
        camera_id=args.camera_id,
        seats=seats,
        cfg=config,
        venue_capacity=args.capacity,
    )

    # Open camera with retry
    cap: Optional[cv2.VideoCapture] = None
    while cap is None:
        try:
            cap = open_capture(args.stream)
        except RuntimeError as exc:
            logger.warning("%s — retrying in %.1fs", exc, config.camera.reconnect_delay)
            time.sleep(config.camera.reconnect_delay)

    target_interval = 1.0 / config.camera.target_fps
    health_key = f"kyro:health:{args.camera_id}"
    health_ttl = 10          # seconds — if worker dies, key expires automatically
    frames_for_fps = 30
    fps_timestamps: list[float] = []

    logger.info(
        "Worker started | camera=%s stream=%s fps=%d seats=%d",
        args.camera_id, args.stream, config.camera.target_fps, len(seats),
    )

    try:
        while True:
            t_loop = time.perf_counter()

            ret, frame = cap.read()
            if not ret:
                logger.warning(
                    "Frame read failed — reconnecting in %.1fs", config.camera.reconnect_delay
                )
                cap.release()
                time.sleep(config.camera.reconnect_delay)
                try:
                    cap = open_capture(args.stream)
                except RuntimeError:
                    continue
                continue

            # Resize if configured
            if config.camera.frame_width > 0:
                frame = cv2.resize(
                    frame, (config.camera.frame_width, config.camera.frame_height)
                )

            # Run full pipeline
            result = pipeline.process_frame(frame)

            # Compute rolling FPS
            now = time.perf_counter()
            fps_timestamps.append(now)
            if len(fps_timestamps) > frames_for_fps:
                fps_timestamps.pop(0)
            fps_actual = (
                len(fps_timestamps) / (fps_timestamps[-1] - fps_timestamps[0])
                if len(fps_timestamps) > 1 else 0.0
            )

            # ── Publish live result to Redis ──────────────────────────────
            payload = {
                "camera_id":    result.camera_id,
                "frame_number": result.frame_number,
                "timestamp":    result.timestamp,
                "attendance": {
                    "current":      result.attendance.current_attendance,
                    "peak":         result.attendance.peak_attendance,
                    "entries":      result.attendance.total_entries,
                    "exits":        result.attendance.total_exits,
                    "occupancy_pct": result.attendance.occupancy_percent,
                },
                "seat_states": result.seat_states,
                "perf": {
                    "inference_ms": result.inference_ms,
                    "total_ms":     result.total_ms,
                },
            }
            r.publish(f"kyro:camera:{args.camera_id}", json.dumps(payload))

            # ── Publish health heartbeat ──────────────────────────────────
            health = {
                "timestamp":    result.timestamp,
                "fps":          round(fps_actual, 1),
                "inference_ms": result.inference_ms,
                "connections":  0,   # filled in by backend if needed
            }
            r.setex(health_key, health_ttl, json.dumps(health))

            # ── Throttle to target FPS ────────────────────────────────────
            elapsed = time.perf_counter() - t_loop
            sleep_time = target_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        logger.info("Worker stopped by user")
    finally:
        if cap:
            cap.release()
        r.delete(health_key)   # clean up health key on exit
        logger.info("Camera released | camera=%s", args.camera_id)


if __name__ == "__main__":
    main()
