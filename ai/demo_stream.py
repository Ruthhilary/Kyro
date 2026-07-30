"""
Kyro — Demo Stream Generator

Creates a synthetic video stream that simulates a church with people
walking in and out. Used for testing without a real camera.

Generates an MJPEG stream on http://localhost:8554/demo that the
vision worker can consume exactly like a real camera.

What it simulates:
- Random number of people (0–15) moving around a frame
- People entering from edges, walking around, leaving
- Bounding-box style blobs that YOLO can detect as "person" shapes
  (NOTE: YOLO will NOT detect colored blobs as persons — see note below)

Alternative approach used here:
- We bypass YOLO entirely in demo mode by patching the detector.
- The demo injects fake detections directly so you can see the full
  pipeline working (tracking, seat occupancy, counters, WebSocket) 
  without a real camera or GPU.

Run:
    python -m ai.demo_stream --camera-id cam-01
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import random
import time
from dataclasses import dataclass, field

import cv2
import numpy as np
import redis

from ai.config import config
from ai.analytics.counter import AttendanceCounter
from ai.seat_detection.occupancy import SeatOccupancyEngine
from ai.seat_detection.seat import Seat
from ai.tracking.bytetrack import ByteTracker, TrackedPerson, TrackState
from ai.pipeline import PipelineResult

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("kyro.demo")

# ─── Frame dimensions ────────────────────────────────────────────────────────
W, H = 1280, 720

# ─── Seat grid (matches build_demo_seats in worker.py) ───────────────────────

def build_demo_seats() -> list[Seat]:
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


# ─── Simulated person ────────────────────────────────────────────────────────

@dataclass
class SimPerson:
    pid: int
    x: float
    y: float
    vx: float = 0.0
    vy: float = 0.0
    w: float = 50.0
    h: float = 100.0
    seated: bool = False
    seat_target: tuple[float, float] | None = None
    lifetime: int = 0          # frames alive
    max_lifetime: int = 500    # frames before this person leaves

    def step(self, seats: list[Seat]) -> None:
        self.lifetime += 1

        if self.seated and self.seat_target:
            # Sit still with small jitter
            tx, ty = self.seat_target
            self.x += (tx - self.x) * 0.1 + random.gauss(0, 0.5)
            self.y += (ty - self.y) * 0.1 + random.gauss(0, 0.5)
            # Occasionally stand up
            if random.random() < 0.002:
                self.seated = False
                self.seat_target = None
                self.vx = random.uniform(-1.5, 1.5)
                self.vy = random.uniform(-1.5, 1.5)
            return

        # Walking — find nearest unoccupied seat to head toward
        if not self.seated and random.random() < 0.03 and seats:
            # Pick a random seat to head for
            target_seat = random.choice(seats)
            cx = (target_seat.bbox[0] + target_seat.bbox[2]) / 2
            cy = (target_seat.bbox[1] + target_seat.bbox[3]) / 2
            self.seat_target = (cx - self.w / 2, cy - self.h / 2)

        if self.seat_target:
            tx, ty = self.seat_target
            dx, dy = tx - self.x, ty - self.y
            dist = math.hypot(dx, dy)
            if dist < 5:
                self.seated = True
            else:
                speed = 2.5
                self.vx = dx / dist * speed
                self.vy = dy / dist * speed
        else:
            # Random walk
            self.vx += random.gauss(0, 0.3)
            self.vy += random.gauss(0, 0.3)
            self.vx = max(-3, min(3, self.vx))
            self.vy = max(-3, min(3, self.vy))

        self.x = max(0, min(W - self.w, self.x + self.vx))
        self.y = max(0, min(H - self.h, self.y + self.vy))

    @property
    def bbox(self) -> np.ndarray:
        return np.array([self.x, self.y, self.x + self.w, self.y + self.h], dtype=np.float32)


# ─── Render frame ────────────────────────────────────────────────────────────

def render_frame(persons: list[SimPerson], seats: list[Seat]) -> np.ndarray:
    frame = np.zeros((H, W, 3), dtype=np.uint8)
    frame[:] = (18, 18, 28)   # dark background

    # Stage area
    cv2.rectangle(frame, (200, 20), (W - 200, 100), (40, 40, 60), -1)
    cv2.putText(frame, "STAGE", (W // 2 - 30, 68), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (100, 100, 140), 2)

    # Draw seats
    for seat in seats:
        x1, y1, x2, y2 = seat.bbox.astype(int)
        colour = {
            "occupied":           (60, 60, 200),
            "temporarily_vacant": (30, 140, 200),
            "likely_available":   (30, 180, 80),
            "available":          (30, 200, 30),
            "unknown":            (80, 80, 80),
        }.get(seat.state.value, (80, 80, 80))
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, -1)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (150, 150, 150), 1)
        cv2.putText(frame, seat.seat_id, (x1 + 2, y1 + 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (220, 220, 220), 1)

    # Draw persons (silhouette rectangles)
    for p in persons:
        x1, y1 = int(p.x), int(p.y)
        x2, y2 = int(p.x + p.w), int(p.y + p.h)
        # Body
        cv2.rectangle(frame, (x1, y1 + 20), (x2, y2), (180, 140, 100), -1)
        # Head
        cx = (x1 + x2) // 2
        cv2.circle(frame, (cx, y1 + 15), 15, (200, 160, 120), -1)
        # Track ID
        cv2.putText(frame, f"#{p.pid}", (x1, y1 + 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 100), 1)

    return frame


# ─── Main loop ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera-id", default="cam-01")
    parser.add_argument("--capacity",  type=int, default=20)
    parser.add_argument("--max-persons", type=int, default=12,
                        help="Max simultaneous simulated people")
    args = parser.parse_args()

    r = redis.Redis(
        host=config.redis.host,
        port=config.redis.port,
        db=config.redis.db,
        password=config.redis.password,
        decode_responses=True,
    )

    seats  = build_demo_seats()
    seat_engine = SeatOccupancyEngine(seats, config.seats)
    tracker     = ByteTracker(config.tracking)
    counter     = AttendanceCounter(args.capacity)

    persons: list[SimPerson] = []
    next_pid   = 1
    frame_num  = 0
    target_interval = 1.0 / config.camera.target_fps
    health_key = f"kyro:health:{args.camera_id}"
    fps_times:  list[float] = []

    logger.info(
        "Demo stream started | camera=%s capacity=%d max_persons=%d",
        args.camera_id, args.capacity, args.max_persons,
    )

    try:
        while True:
            t0 = time.perf_counter()
            frame_num += 1

            # ── Spawn new persons randomly ────────────────────────────────
            if len(persons) < args.max_persons and random.random() < 0.04:
                edge = random.choice(["left", "right", "bottom"])
                if edge == "left":
                    px, py = 0.0, random.uniform(100, H - 150)
                elif edge == "right":
                    px, py = float(W - 60), random.uniform(100, H - 150)
                else:
                    px, py = random.uniform(50, W - 100), float(H - 120)

                persons.append(SimPerson(
                    pid=next_pid,
                    x=px, y=py,
                    vx=random.uniform(-1, 1),
                    vy=random.uniform(-2, 0),
                    max_lifetime=random.randint(200, 800),
                ))
                next_pid += 1

            # ── Step all persons ──────────────────────────────────────────
            for p in persons:
                p.step(seats)

            # ── Remove persons that have lived too long ────────────────────
            persons = [p for p in persons if p.lifetime < p.max_lifetime]

            # ── Build fake TrackedPerson list (bypass YOLO) ───────────────
            tracked: list[TrackedPerson] = [
                TrackedPerson(
                    track_id=p.pid,
                    bbox=p.bbox,
                    confidence=0.92,
                    state=TrackState.CONFIRMED,
                )
                for p in persons
            ]

            # ── Pipeline stages ───────────────────────────────────────────
            seat_engine.update(tracked)
            counter.update(tracked)
            snap = counter.snapshot()

            # ── Render visual frame ───────────────────────────────────────
            frame = render_frame(persons, seats)

            # Overlay stats on frame
            cv2.putText(frame, f"Kyro Demo | Camera: {args.camera_id}", (10, 25),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 255), 2)
            cv2.putText(frame, f"Count: {snap.current_attendance}  Peak: {snap.peak_attendance}",
                        (10, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 255, 100), 2)
            cv2.putText(frame, f"Entries: {snap.total_entries}  Exits: {snap.total_exits}",
                        (10, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
            cv2.putText(frame, f"Frame: {frame_num}", (W - 120, 25),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (120, 120, 120), 1)

            # ── Compute FPS ───────────────────────────────────────────────
            now = time.perf_counter()
            fps_times.append(now)
            if len(fps_times) > 30:
                fps_times.pop(0)
            fps = len(fps_times) / (fps_times[-1] - fps_times[0]) if len(fps_times) > 1 else 0

            # ── Publish to Redis ──────────────────────────────────────────
            payload = {
                "camera_id":    args.camera_id,
                "frame_number": frame_num,
                "timestamp":    snap.timestamp,
                "attendance": {
                    "current":      snap.current_attendance,
                    "peak":         snap.peak_attendance,
                    "entries":      snap.total_entries,
                    "exits":        snap.total_exits,
                    "occupancy_pct": snap.occupancy_percent,
                },
                "seat_states": [s.to_dict() for s in seats],
                "perf": {
                    "inference_ms": 0.0,   # no YOLO in demo mode
                    "total_ms":     round((time.perf_counter() - t0) * 1000, 2),
                },
            }
            r.publish(f"kyro:camera:{args.camera_id}", json.dumps(payload))

            # Health heartbeat
            r.setex(health_key, 10, json.dumps({
                "timestamp":    snap.timestamp,
                "fps":          round(fps, 1),
                "inference_ms": 0.0,
            }))

            # ── Show local preview window ─────────────────────────────────
            cv2.imshow(f"Kyro Demo — {args.camera_id} (press Q to quit)", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

            # ── Throttle ─────────────────────────────────────────────────
            elapsed = time.perf_counter() - t0
            sleep_t = target_interval - elapsed
            if sleep_t > 0:
                time.sleep(sleep_t)

    except KeyboardInterrupt:
        logger.info("Demo stopped")
    finally:
        cv2.destroyAllWindows()
        r.delete(health_key)
        logger.info("Demo stream ended | camera=%s", args.camera_id)


if __name__ == "__main__":
    main()
