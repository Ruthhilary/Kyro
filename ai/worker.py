"""
Kyro — Vision Worker

Entry point for the AI inference process.
Reads frames from a camera stream, runs the VisionPipeline,
and publishes results to Redis for the backend to broadcast.

Run:
    python -m ai.worker --camera-id cam-01 --stream 0
    python -m ai.worker --camera-id cam-01 --stream rtsp://192.168.1.10/stream
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from dataclasses import asdict

import cv2
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Kyro Vision Worker")
    parser.add_argument("--camera-id", default="cam-01", help="Unique camera identifier")
    parser.add_argument("--stream", default="0", help="Stream source (device index or URL)")
    parser.add_argument("--capacity", type=int, default=0, help="Venue seat capacity")
    return parser.parse_args()


def open_capture(stream: str) -> cv2.VideoCapture:
    """Open a video capture with reconnect support."""
    source = int(stream) if stream.isdigit() else stream
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open stream: {stream}")
    logger.info("Camera stream opened | source=%s", stream)
    return cap


def build_demo_seats(n: int = 20) -> list[Seat]:
    """
    Create a demo seat layout for testing without a real seat map.
    Seats are arranged in a 4×5 grid across the frame.
    """
    seats: list[Seat] = []
    rows = ["A", "B", "C", "D"]
    cols = 5
    seat_w, seat_h = 80, 80

    for r_idx, row in enumerate(rows):
        for c in range(1, cols + 1):
            x1 = 100 + (c - 1) * 120
            y1 = 150 + r_idx * 110
            seats.append(
                Seat(
                    seat_id=f"{row}-{c}",
                    bbox=np.array([x1, y1, x1 + seat_w, y1 + seat_h], dtype=np.float32),
                    row=row,
                    number=c,
                    section="Main Floor",
                )
            )
    return seats


def main() -> None:
    args = parse_args()

    # Redis client for publishing results
    r = redis.Redis(
        host=config.redis.host,
        port=config.redis.port,
        db=config.redis.db,
        password=config.redis.password,
        decode_responses=True,
    )

    # Build pipeline
    seats = build_demo_seats()
    pipeline = VisionPipeline(
        camera_id=args.camera_id,
        seats=seats,
        cfg=config,
        venue_capacity=args.capacity,
    )

    # Open camera
    cap = open_capture(args.stream)

    target_interval = 1.0 / config.camera.target_fps
    logger.info("Worker started | camera=%s fps=%d", args.camera_id, config.camera.target_fps)

    try:
        while True:
            t_loop = time.perf_counter()

            ret, frame = cap.read()
            if not ret:
                logger.warning("Frame read failed — attempting reconnect in %.1fs", config.camera.reconnect_delay)
                cap.release()
                time.sleep(config.camera.reconnect_delay)
                cap = open_capture(args.stream)
                continue

            # Resize if configured
            if config.camera.frame_width > 0:
                frame = cv2.resize(frame, (config.camera.frame_width, config.camera.frame_height))

            # Run pipeline
            result = pipeline.process_frame(frame)

            # Publish to Redis channel (backend subscribes and broadcasts via WS)
            payload = {
                "camera_id": result.camera_id,
                "frame_number": result.frame_number,
                "timestamp": result.timestamp,
                "attendance": {
                    "current": result.attendance.current_attendance,
                    "peak": result.attendance.peak_attendance,
                    "entries": result.attendance.total_entries,
                    "exits": result.attendance.total_exits,
                    "occupancy_pct": result.attendance.occupancy_percent,
                },
                "seat_states": result.seat_states,
                "perf": {
                    "inference_ms": result.inference_ms,
                    "total_ms": result.total_ms,
                },
            }
            r.publish(f"kyro:camera:{args.camera_id}", json.dumps(payload))

            # Throttle to target FPS
            elapsed = time.perf_counter() - t_loop
            sleep_time = target_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        logger.info("Worker stopped by user")
    finally:
        cap.release()
        logger.info("Camera released")


if __name__ == "__main__":
    main()
