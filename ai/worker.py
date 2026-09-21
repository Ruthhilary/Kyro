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
- Zone metadata fetched from backend (zone_name, zone_capacity, zone_order)
- Multiple workers can run simultaneously (one per camera)

Run:
    python -m ai.worker --camera-id cam-01 --stream 0
    python -m ai.worker --camera-id cam-01 --stream rtsp://192.168.1.10/stream
    python -m ai.worker --camera-id cam-02 --stream 0 --capacity 300 --layout-id 1
"""

from __future__ import annotations

import argparse
import os
import json
import logging
import signal
import sys
import time
from dataclasses import dataclass
from typing import Optional

import cv2
import httpx
import numpy as np
import redis

from ai.config import config
from ai.pipeline import VisionPipeline
from ai.seat_detection.seat import Seat
from ai.seat_detection.zones import ExclusionZone
from ai.seat_detection.rota import RotaEntry, RotaManager

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
    # Defaults now read from env vars first, so docker-compose's
    # `environment:` block actually takes effect. Previously these were
    # hardcoded (e.g. backend-url defaulted to http://localhost:8000 no
    # matter what BACKEND_URL was set to) — inside the vision container,
    # "localhost" means the vision container itself, not the backend
    # service, so the worker could never actually fetch camera/zone/seat
    # config from the backend when run via docker-compose. CLI flags still
    # override the env var if both are given.
    p.add_argument("--camera-id",   default=os.environ.get("CAMERA_ID", "cam-01"),
                    help="Unique camera identifier")
    p.add_argument("--stream",      default=os.environ.get("STREAM_SOURCE", "0"),
                    help="Stream source: webcam index (e.g. 0), a device path "
                         "(e.g. /dev/video0), or an RTSP/HTTP URL")
    p.add_argument("--capacity",    type=int, default=int(os.environ.get("VENUE_CAPACITY", "0")),
                    help="Venue seat capacity (overrides backend value)")
    p.add_argument("--layout-id",   type=int, default=(int(os.environ["LAYOUT_ID"]) if os.environ.get("LAYOUT_ID") else None),
                    help="Seat layout DB id to load on startup")
    p.add_argument("--api-key",     default=os.environ.get("KYRO_API_KEY"),
                    help="Backend API key")
    p.add_argument("--backend-url", default=os.environ.get("BACKEND_URL", "http://localhost:8000"),
                    help="Backend base URL")
    p.add_argument("--device",      default=os.environ.get("DETECTION_DEVICE"),
                    help="Inference device: cpu | cuda | mps (overrides config)")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Camera info from backend
# ---------------------------------------------------------------------------

@dataclass
class CameraInfo:
    zone_name: str
    zone_capacity: int
    zone_order: int


@dataclass
class CameraPolicies:
    exclusion_zones: list[ExclusionZone]
    rota_entries: list[RotaEntry]
    reserved_seats: list[dict]   # [{"seat_id": str, "reserved_for": str|None}]


def fetch_camera_info(camera_id: str, backend_url: str, api_key: str) -> Optional[CameraInfo]:
    """Fetch zone metadata for this camera from the backend."""
    url = f"{backend_url}/api/v1/cameras/{camera_id}"
    try:
        resp = httpx.get(url, headers={"X-API-Key": api_key}, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return CameraInfo(
            zone_name=data.get("zone_name") or camera_id,
            zone_capacity=data.get("zone_capacity") or 0,
            zone_order=data.get("zone_order") or 0,
        )
    except Exception as exc:
        logger.warning("Could not fetch camera info for %s: %s", camera_id, exc)
        return None


def fetch_camera_policies(camera_id: str, backend_url: str, api_key: str) -> CameraPolicies:
    """Load exclusion zones, rota entries, and reserved seats from the backend."""
    headers = {"X-API-Key": api_key}
    zones: list[ExclusionZone] = []
    rota:  list[RotaEntry]     = []
    reserved: list[dict]       = []

    try:
        r = httpx.get(f"{backend_url}/api/v1/zones/{camera_id}", headers=headers, timeout=10)
        r.raise_for_status()
        for z in r.json():
            zones.append(ExclusionZone(
                zone_id=z["zone_id"],
                bbox=np.array(z["bbox"], dtype=np.float32),
                label=z.get("label", ""),
                hold_seats_in_rows=z.get("hold_seats_in_rows", []),
            ))
        logger.info("Loaded %d exclusion zones", len(zones))
    except Exception as exc:
        logger.warning("Could not load zones for %s: %s", camera_id, exc)

    try:
        r = httpx.get(f"{backend_url}/api/v1/rota/{camera_id}", headers=headers, timeout=10)
        r.raise_for_status()
        from datetime import datetime, timezone as _tz
        for entry in r.json():
            start = datetime.fromisoformat(entry["start_time"]).replace(tzinfo=_tz.utc).timestamp()
            end   = datetime.fromisoformat(entry["end_time"]).replace(tzinfo=_tz.utc).timestamp()
            rota.append(RotaEntry(
                entry_id=entry["entry_id"], label=entry["label"],
                start_epoch=start, end_epoch=end,
                seat_ids=entry.get("seat_ids", []),
                rows=entry.get("rows", []),
                section=entry.get("section"),
            ))
        logger.info("Loaded %d rota entries", len(rota))
    except Exception as exc:
        logger.warning("Could not load rota for %s: %s", camera_id, exc)

    try:
        r = httpx.get(f"{backend_url}/api/v1/reserved/{camera_id}", headers=headers, timeout=10)
        r.raise_for_status()
        reserved = r.json()
        logger.info("Loaded %d reserved seats", len(reserved))
    except Exception as exc:
        logger.warning("Could not load reserved seats for %s: %s", camera_id, exc)

    return CameraPolicies(exclusion_zones=zones, rota_entries=rota, reserved_seats=reserved)


def fetch_spatial_memory(camera_id: str, backend_url: str, api_key: str) -> list[dict]:
    """Load persisted spatial memory from backend so known regions are never re-asked."""
    try:
        resp = httpx.get(
            f"{backend_url}/api/v1/review/{camera_id}/memory",
            headers={"X-API-Key": api_key},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return data  # list of {region_key, cx, cy, classification, confirmation_count, ...}
    except Exception as exc:
        logger.warning("Could not load spatial memory for %s: %s", camera_id, exc)
        return []


# ---------------------------------------------------------------------------
# Camera stream open
# ---------------------------------------------------------------------------

def open_capture(stream: str) -> cv2.VideoCapture:
    source: int | str = int(stream) if stream.isdigit() else stream
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open stream: {stream!r}")
    # Prefer lower latency buffer for RTSP
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
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
    """Fetch a saved seat layout from the backend REST API."""
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
    Realistic demo seat grid: 7 rows (A–G), tapering widths like a real auditorium.
    Matches the floor plan shown in the Kyro screenshots.
    """
    row_config = [
        ("A", 10), ("B", 13), ("C", 13), ("D", 14),
        ("E", 14), ("F", 13), ("G", 14),
    ]
    seat_w, seat_h = 60, 48
    gap_x, gap_y   = 8, 12
    base_x, base_y = 80, 120
    seats: list[Seat] = []

    frame_w = 1280
    for r_idx, (row, count) in enumerate(row_config):
        row_total_w = count * seat_w + (count - 1) * gap_x
        x_start = (frame_w - row_total_w) // 2
        y = base_y + r_idx * (seat_h + gap_y)
        for c in range(count):
            x1 = x_start + c * (seat_w + gap_x)
            seats.append(Seat(
                seat_id=f"{row}{c + 1}",
                bbox=np.array([x1, y, x1 + seat_w, y + seat_h], dtype=np.float32),
                row=row,
                number=c + 1,
                section="Main Floor",
            ))

    return seats


# ---------------------------------------------------------------------------
# Snapshot annotation
# ---------------------------------------------------------------------------

INDIGO = (241, 102, 99)   # BGR for #6366f1
WHITE  = (255, 255, 255)
BLACK  = (0, 0, 0)


def annotate_frame(frame: np.ndarray, result: "PipelineResult", zone_name: str) -> np.ndarray:  # type: ignore[name-defined]
    """Draw tracking boxes, count overlay, and zone label on a copy of frame."""
    out = frame.copy()
    h, w = out.shape[:2]

    # Draw person bounding boxes
    for person in result.tracked_persons:
        x1, y1, x2, y2 = [int(v) for v in person.bbox]
        cv2.rectangle(out, (x1, y1), (x2, y2), INDIGO, 2)
        label_y = max(y1 - 6, 14)
        cv2.putText(out, f"#{person.track_id}", (x1 + 2, label_y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, INDIGO, 1, cv2.LINE_AA)

    # Top-left count overlay (dark pill)
    count     = result.attendance.current_attendance
    count_txt = f"  {count} people"
    pill_w    = 200
    pill_h    = 34
    overlay   = out.copy()
    cv2.rectangle(overlay, (0, 0), (pill_w, pill_h), (13, 15, 26), -1)
    cv2.addWeighted(overlay, 0.8, out, 0.2, 0, out)
    cv2.putText(out, count_txt, (8, 23),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, WHITE, 1, cv2.LINE_AA)

    # Zone name (bottom-left)
    cv2.putText(out, zone_name, (10, h - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1, cv2.LINE_AA)

    return out


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()

    # Override device if passed via CLI
    if args.device:
        config.detection.device = args.device

    # Redis client (decode_responses=True for JSON payloads)
    r = redis.Redis(
        host=config.redis.host,
        port=config.redis.port,
        db=config.redis.db,
        password=config.redis.password,
        decode_responses=True,
    )
    # Separate binary client for JPEG snapshots
    r_bytes = redis.Redis(
        host=config.redis.host,
        port=config.redis.port,
        db=config.redis.db,
        password=config.redis.password,
        decode_responses=False,
    )

    api_key = args.api_key or "kyro-dev-key-change-in-production"

    # Fetch zone metadata from backend
    cam_info = fetch_camera_info(args.camera_id, args.backend_url, api_key)
    zone_name     = (cam_info.zone_name if cam_info else args.camera_id)
    zone_capacity = args.capacity or (cam_info.zone_capacity if cam_info else 0)
    zone_order    = cam_info.zone_order if cam_info else 0

    # Load seat layout
    if args.layout_id is not None:
        seats = load_seats_from_api(args.camera_id, args.layout_id, args.backend_url, api_key)
    else:
        seats = build_demo_seats()

    # Build pipeline
    pipeline = VisionPipeline(
        camera_id=args.camera_id,
        seats=seats,
        cfg=config,
        venue_capacity=zone_capacity,
    )

    # Load and apply policies (zones, rota, reserved seats)
    policies = fetch_camera_policies(args.camera_id, args.backend_url, api_key)
    if policies.exclusion_zones:
        pipeline._seat_engine.set_exclusion_zones(policies.exclusion_zones)
    if policies.rota_entries:
        pipeline._seat_engine.rota.load(policies.rota_entries)
    for res in policies.reserved_seats:
        pipeline._seat_engine.set_reserved(res["seat_id"], True, res.get("reserved_for"))

    # Load spatial memory so the system doesn't re-ask about known regions
    spatial_memory = fetch_spatial_memory(args.camera_id, args.backend_url, api_key)
    if spatial_memory:
        pipeline._movement.review_queue.load_memory(spatial_memory)
        logger.info("Loaded %d spatial memory regions for camera %s", len(spatial_memory), args.camera_id)

    # Subscribe to review answers from the dashboard (non-blocking, checked each frame)
    review_answer_key = f"kyro:review_answer:{args.camera_id}"
    review_pubsub = redis.Redis(
        host=config.redis.host,
        port=config.redis.port,
        db=config.redis.db,
        password=config.redis.password,
        decode_responses=True,
    ).pubsub()
    review_pubsub.subscribe(review_answer_key)

    # Open camera with retry loop
    cap: Optional[cv2.VideoCapture] = None
    while cap is None:
        try:
            cap = open_capture(args.stream)
        except RuntimeError as exc:
            logger.warning("%s — retrying in %.1fs", exc, config.camera.reconnect_delay)
            time.sleep(config.camera.reconnect_delay)

    target_interval   = 1.0 / config.camera.target_fps
    health_key        = f"kyro:health:{args.camera_id}"
    health_ttl        = 10      # key expires if worker crashes
    snapshot_interval = 3       # annotate every N frames
    fps_window        = 30
    fps_timestamps: list[float] = []
    _last_seat_states: dict[str, str] = {}   # seat_id → last published state (for delta)

    # ── Camera health beyond "did cap.read() return a frame" ─────────────
    # A physically disconnected/faulty USB camera doesn't always make
    # OpenCV/V4L2 report failure — some drivers keep returning ret=True
    # with a frozen or solid-black frame. Without this check, the health
    # heartbeat below would keep refreshing (worker thinks it's fine)
    # while the actual feed is dead — which looks like "shows online when
    # the camera is offline" on the dashboard. Two independent signals:
    #   - blank frame: near-zero pixel variance (solid black/gray/green,
    #     the classic "no signal" output of a dead sensor or bad cable)
    #   - frozen frame: essentially identical to the previous frame for a
    #     sustained period (a stuck driver replaying its last good frame)
    _BLANK_STD_THRESHOLD  = 3.0     # pixel std-dev below this = blank
    _FROZEN_DIFF_THRESHOLD = 0.5    # mean abs diff below this = frozen
    _FROZEN_SUSTAIN_FRAMES = int(config.camera.target_fps * 5)  # ~5s
    _prev_gray_small: Optional[np.ndarray] = None
    _frozen_count = 0

    def _camera_error_status(frame: np.ndarray) -> Optional[str]:
        """Returns an error reason string, or None if the frame looks healthy."""
        nonlocal _prev_gray_small, _frozen_count
        small = cv2.resize(frame, (64, 36))
        gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        if float(gray.std()) < _BLANK_STD_THRESHOLD:
            _frozen_count = 0
            return "blank_frame"

        if _prev_gray_small is not None:
            diff = float(np.mean(cv2.absdiff(gray, _prev_gray_small)))
            if diff < _FROZEN_DIFF_THRESHOLD:
                _frozen_count += 1
            else:
                _frozen_count = 0
        _prev_gray_small = gray

        if _frozen_count >= _FROZEN_SUSTAIN_FRAMES:
            return "frozen_frame"
        return None

    # Graceful shutdown on SIGTERM (e.g. Docker stop)
    _running = True
    def _handle_signal(sig, frame):  # noqa: ANN001
        nonlocal _running
        logger.info("Signal %d received — shutting down", sig)
        _running = False
    signal.signal(signal.SIGTERM, _handle_signal)

    logger.info(
        "Worker started | camera=%s zone=%r stream=%s fps=%d seats=%d capacity=%d device=%s",
        args.camera_id, zone_name, args.stream,
        config.camera.target_fps, len(seats), zone_capacity,
        config.detection.device,
    )

    try:
        while _running:
            t_loop = time.perf_counter()

            ret, frame = cap.read()
            if not ret:
                logger.warning("Frame read failed — reconnecting in %.1fs", config.camera.reconnect_delay)
                cap.release()
                time.sleep(config.camera.reconnect_delay)
                try:
                    cap = open_capture(args.stream)
                except RuntimeError:
                    continue
                continue

            # Resize to configured resolution
            if config.camera.frame_width > 0:
                frame = cv2.resize(frame, (config.camera.frame_width, config.camera.frame_height))

            camera_error = _camera_error_status(frame)

            # ── Run vision pipeline ───────────────────────────────────────
            result = pipeline.process_frame(frame)

            # ── Rolling FPS calculation ───────────────────────────────────
            now = time.perf_counter()
            fps_timestamps.append(now)
            if len(fps_timestamps) > fps_window:
                fps_timestamps.pop(0)
            fps_actual = (
                len(fps_timestamps) / (fps_timestamps[-1] - fps_timestamps[0])
                if len(fps_timestamps) > 1 else 0.0
            )

            # ── Process any incoming review answers ───────────────────
            msg = review_pubsub.get_message(ignore_subscribe_messages=True)
            while msg:
                try:
                    data = json.loads(msg["data"])
                    if data.get("type") == "review_answer":
                        pipeline._movement.apply_answer(
                            data["review_id"], data["answer"]
                        )
                        # Drain any persistence items and publish back to backend
                        to_persist = pipeline._movement.review_queue.drain_persist_queue()
                        for item in to_persist:
                            r.publish(
                                f"kyro:memory_persist:{args.camera_id}",
                                json.dumps(item),
                            )
                except Exception as exc:
                    logger.warning("Review answer processing error: %s", exc)
                msg = review_pubsub.get_message(ignore_subscribe_messages=True)

            # ── Publish live result to Redis ──────────────────────────────
            # For large layouts: publish a full snapshot every 30 frames,
            # and only changed seats (delta) every other frame.
            # This cuts Redis bandwidth by ~95% at 10k+ seats.
            is_snapshot_frame = (result.frame_number % 30 == 1)

            if is_snapshot_frame:
                seat_payload = result.seat_states
                msg_type = "snapshot"
                # Update last-known state for delta tracking
                _last_seat_states = {s["seat_id"]: s["state"] for s in result.seat_states}
            else:
                # Only send seats whose state changed since last frame
                changed = [
                    s for s in result.seat_states
                    if _last_seat_states.get(s["seat_id"]) != s["state"]
                ]
                for s in result.seat_states:
                    _last_seat_states[s["seat_id"]] = s["state"]
                seat_payload = changed
                msg_type = "delta"

            payload = {
                "type":         msg_type,
                "camera_id":    result.camera_id,
                "frame_number": result.frame_number,
                "timestamp":    result.timestamp,
                "zone": {
                    "name":     zone_name,
                    "capacity": zone_capacity,
                    "order":    zone_order,
                },
                "attendance": {
                    "current":       result.attendance.current_attendance,
                    "peak":          result.attendance.peak_attendance,
                    "entries":       result.attendance.total_entries,
                    "exits":         result.attendance.total_exits,
                    "occupancy_pct": result.attendance.occupancy_percent,
                },
                "seat_states": seat_payload,
                "perf": {
                    "inference_ms": round(result.inference_ms, 2),
                    "total_ms":     round(result.total_ms, 2),
                    "fps":          round(fps_actual, 1),
                },
            }
            r.publish(f"kyro:camera:{args.camera_id}", json.dumps(payload))

            # ── Publish seat-available alerts ─────────────────────────
            # newly_available_seat_ids is an EDGE (fires once, the exact
            # frame a seat first becomes available), not a level — see
            # SeatOccupancyEngine.newly_available_seat_ids. Each one gets
            # a real evidence snapshot (not just a colour change in the
            # UI), cropped from the seat's own known bbox with generous
            # padding so the surrounding context (row, neighbours) is
            # visible too — the frontend adds zoom/pan on top of this for
            # a closer look.
            for seat_id in result.newly_available_seat_ids:
                seat_bbox = pipeline.get_seat_bbox(seat_id)
                if seat_bbox is None:
                    continue
                sx1, sy1, sx2, sy2 = [float(v) for v in seat_bbox]
                scx, scy = (sx1 + sx2) / 2, (sy1 + sy2) / 2
                fh, fw = frame.shape[:2]
                # Pad generously around the seat itself so ushers can see
                # the row/neighbouring seats for context, not just a tight
                # crop of the empty seat alone.
                seat_w, seat_h = max(40.0, sx2 - sx1), max(40.0, sy2 - sy1)
                pad_x, pad_y = seat_w * 1.5, seat_h * 1.5
                ax1 = int(max(0, sx1 - pad_x))
                ay1 = int(max(0, sy1 - pad_y))
                ax2 = int(min(fw, sx2 + pad_x))
                ay2 = int(min(fh, sy2 + pad_y))
                crop = frame[ay1:ay2, ax1:ax2].copy()
                if crop.size > 0:
                    # Highlight the exact seat within the wider crop
                    rx1, ry1 = int(sx1 - ax1), int(sy1 - ay1)
                    rx2, ry2 = int(sx2 - ax1), int(sy2 - ay1)
                    cv2.rectangle(crop, (rx1, ry1), (rx2, ry2), (34, 197, 94), 3)
                    cv2.putText(crop, f"Seat {seat_id} available", (8, 20),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
                    ok_seat, buf_seat = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if ok_seat:
                        # 10 min TTL — long enough for an usher to notice
                        # and act, short enough not to linger as a stale
                        # "available" photo of a seat someone since took.
                        r_bytes.setex(
                            f"kyro:seat_alert_snap:{args.camera_id}:{seat_id}",
                            600,
                            buf_seat.tobytes(),
                        )

                alert_payload = {
                    "type": "seat_available_alert",
                    "camera_id": args.camera_id,
                    "seat_id": seat_id,
                    "timestamp": result.timestamp,
                }
                r.publish(f"kyro:camera:{args.camera_id}", json.dumps(alert_payload))
                logger.info("Seat available alert published | seat_id=%s", seat_id)

            # ── Publish any new review requests ───────────────────────
            for review_req in pipeline._movement.new_review_requests:
                review_payload = review_req.to_dict()

                # ── Publish a cropped snapshot for this review ────────
                # Crop and zoom the current frame around the person's position
                if review_req.position and review_req.position != (0.0, 0.0):
                    cx, cy = review_req.position
                    fh, fw = frame.shape[:2]
                    # Crop a 320x240 region centred on the person, clamped to frame
                    pad_x, pad_y = 160, 120
                    x1c = int(max(0, cx - pad_x))
                    y1c = int(max(0, cy - pad_y))
                    x2c = int(min(fw, cx + pad_x))
                    y2c = int(min(fh, cy + pad_y))
                    crop = frame[y1c:y2c, x1c:x2c].copy()
                    # Draw a bright highlight ring at the person's position in the crop
                    person_x_in_crop = int(cx - x1c)
                    person_y_in_crop = int(cy - y1c)
                    cv2.circle(crop, (person_x_in_crop, person_y_in_crop), 40, (99, 102, 241), 3)
                    cv2.circle(crop, (person_x_in_crop, person_y_in_crop), 42, (255, 255, 255), 1)
                    # Label
                    cv2.putText(crop, "Kyro flagged", (8, 20),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
                    ok_crop, buf_crop = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ok_crop:
                        r_bytes.setex(
                            f"kyro:review_snap:{args.camera_id}:{review_req.review_id}",
                            120,
                            buf_crop.tobytes(),
                        )

                r.publish(f"kyro:camera:{args.camera_id}", json.dumps(review_payload))
                r.setex(
                    f"kyro:review:{args.camera_id}:{review_req.review_id}",
                    120,
                    json.dumps(review_payload),
                )
                logger.info(
                    "Review request published | id=%s type=%s",
                    review_req.review_id, review_req.review_type,
                )

            # ── Publish zone proposals if threshold reached ────────────
            proposals = pipeline._movement.review_queue.get_zone_proposals()
            if proposals:
                r.publish(
                    f"kyro:camera:{args.camera_id}",
                    json.dumps({
                        "type":     "zone_proposals",
                        "camera_id": args.camera_id,
                        "proposals": [
                            {"cx": cx, "cy": cy, "confirmations": n}
                            for cx, cy, n in proposals
                        ],
                    }),
                )

            # ── Live annotated frame — published every processed frame ────
            # Previously this only wrote a JPEG to a Redis key every 3rd
            # frame, which the dashboard polled every 2s — meaning what you
            # saw was up to ~2s (or more, under load) stale. Now every
            # processed frame is JPEG-encoded and published on a pub/sub
            # channel; the backend's /stream endpoint relays it to the
            # browser as an MJPEG stream in real time, no polling involved.
            annotated = annotate_frame(frame, result, zone_name)
            ok, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 72])
            if ok:
                jpeg_bytes = buf.tobytes()
                r.publish(f"kyro:frame:{args.camera_id}", jpeg_bytes)
                # Also keep the short-TTL key as a fallback for any client
                # that just wants a single still (e.g. review-answer emails).
                r_bytes.setex(f"kyro:snapshot:{args.camera_id}", 5, jpeg_bytes)

            # ── Health heartbeat ──────────────────────────────────────────
            r.setex(
                health_key,
                health_ttl,
                json.dumps({
                    "timestamp":    result.timestamp,
                    "fps":          round(fps_actual, 1),
                    "inference_ms": round(result.inference_ms, 2),
                    "zone_name":    zone_name,
                    "current":      result.attendance.current_attendance,
                    "peak":         result.attendance.peak_attendance,
                    "total_entries": result.attendance.total_entries,
                    "total_exits":   result.attendance.total_exits,
                    "occupancy_pct": result.attendance.occupancy_percent,
                    # "online" = frames flowing and look healthy; "error" =
                    # frames are flowing but look blank/frozen (camera
                    # physically failed without OpenCV noticing) — the
                    # dashboard should show this distinctly from a clean
                    # offline (no heartbeat at all = worker/stream is down).
                    "status":       "error" if camera_error else "online",
                    "error_reason": camera_error,
                }),
            )

            # ── Frame rate throttle ───────────────────────────────────────
            elapsed    = time.perf_counter() - t_loop
            sleep_time = target_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        logger.info("Worker stopped by keyboard interrupt")
    finally:
        if cap:
            cap.release()
        # Remove health key immediately so dashboard shows "offline"
        try:
            r.delete(health_key)
        except Exception:
            pass
        logger.info("Worker exited cleanly | camera=%s", args.camera_id)


if __name__ == "__main__":
    main()
