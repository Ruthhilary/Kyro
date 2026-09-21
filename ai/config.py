"""
Kyro AI Engine — Central Configuration

All tunable parameters live here. Override via environment variables
or a local .env file. Never hardcode values in detection/tracking modules.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT_DIR = Path(__file__).parent
MODELS_DIR = ROOT_DIR / "models" / "weights"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------
@dataclass
class DetectionConfig:
    # YOLO model variant: yolov8n / yolov8s / yolov8m / yolov8l / yolov8x
    model_name: str = os.getenv("YOLO_MODEL", "yolov8n.pt")
    model_path: Path = field(default_factory=lambda: MODELS_DIR / os.getenv("YOLO_MODEL", "yolov8n.pt"))

    # Inference settings.
    # NOTE: biased toward recall over precision — a missed person is worse
    # than an extra false-positive box that gets filtered by tracking, since
    # every person needs to be counted. If you see too many false detections
    # (e.g. flagging chairs/bags), raise DETECTION_CONF back up.
    confidence_threshold: float = float(os.getenv("DETECTION_CONF", "0.30"))
    # NMS IoU — HIGHER means less aggressive suppression, which matters when
    # people are seated close together (e.g. a full pew): two real, adjacent
    # people can produce overlapping boxes that a low NMS threshold would
    # incorrectly collapse into one.
    iou_threshold: float = float(os.getenv("DETECTION_IOU", "0.60"))
    device: str = os.getenv("DETECTION_DEVICE", "cuda")  # "cuda" | "cpu" | "mps"

    # Only detect person class (class 0 in COCO)
    target_classes: list[int] = field(default_factory=lambda: [0])

    # Image size fed into model (must be multiple of 32)
    imgsz: int = int(os.getenv("DETECTION_IMGSZ", "640"))

    # Max detections per frame (safety limit)
    max_det: int = int(os.getenv("DETECTION_MAX_DET", "300"))

    # ── Overhead / birds-eye camera mode ──────────────────────────────
    # The default YOLO "person" class is trained mostly on standing/side-on
    # views, not top-down head views — an overhead camera will miss people
    # (their body isn't visible, just a head/shoulders) and can occasionally
    # false-positive on round/head-sized objects (bags, hats on a table).
    #
    # This mode does NOT retrain or replace the detection model — that
    # needs a model actually trained on top-down imagery (e.g. SCUT-HEAD,
    # CroHD datasets), which requires real footage/data and a GPU training
    # run this environment doesn't have. What it DOES do: apply shape/size
    # heuristics on top of whatever the model proposes, biased toward
    # rejecting boxes that don't look head-shaped, to cut down on obvious
    # non-human false positives from an overhead angle.
    #
    # To use a proper head-detection model once you have one: just point
    # model_path/model_name at it — everything else (tracking, seat
    # matching, attendance counting) works unchanged.
    overhead_mode: bool = os.getenv("DETECTION_OVERHEAD_MODE", "false").lower() == "true"
    # Heads viewed from directly above are roughly round → width/height
    # near 1.0. Real people's heads rarely produce boxes this elongated;
    # a box far outside this range is more likely a bag, chair-back, etc.
    overhead_min_aspect_ratio: float = float(os.getenv("DETECTION_OVERHEAD_MIN_ASPECT", "0.55"))
    overhead_max_aspect_ratio: float = float(os.getenv("DETECTION_OVERHEAD_MAX_ASPECT", "1.8"))
    # Reject boxes that are implausibly tiny or huge relative to the frame
    # to be a head (dust/noise vs. a box covering half the ceiling camera's
    # view). Expressed as a fraction of total frame area.
    overhead_min_area_frac: float = float(os.getenv("DETECTION_OVERHEAD_MIN_AREA_FRAC", "0.0008"))
    overhead_max_area_frac: float = float(os.getenv("DETECTION_OVERHEAD_MAX_AREA_FRAC", "0.08"))


# ---------------------------------------------------------------------------
# Tracking (ByteTrack)
# ---------------------------------------------------------------------------
@dataclass
class TrackingConfig:
    # Max frames to keep a lost track alive before dropping
    max_age: int = int(os.getenv("TRACK_MAX_AGE", "30"))

    # Minimum consecutive detections before a track is confirmed.
    # LOWERED from 3 → 2: at 3, anyone briefly occluded in their first 3
    # frames (e.g. walking in behind another person) never gets confirmed
    # and is silently dropped as a stale tentative track — undercounting
    # attendance. 2 still filters single-frame noise/false detections while
    # confirming real people much faster.
    min_hits: int = int(os.getenv("TRACK_MIN_HITS", "2"))

    # IoU threshold for matching detections to existing tracks
    iou_threshold: float = float(os.getenv("TRACK_IOU_THRESHOLD", "0.3"))

    # High/low confidence split for ByteTrack two-stage matching
    high_thresh: float = float(os.getenv("TRACK_HIGH_THRESH", "0.6"))
    low_thresh: float = float(os.getenv("TRACK_LOW_THRESH", "0.1"))


# ---------------------------------------------------------------------------
# Seat Occupancy
# ---------------------------------------------------------------------------
@dataclass
class SeatConfig:
    # Overlap ratio (IoU) needed to call a seat "occupied"
    occupancy_iou_threshold: float = float(os.getenv("SEAT_IOU_THRESH", "0.3"))

    # Seconds before a vacated seat transitions from
    # TEMPORARILY_VACANT → LIKELY_AVAILABLE
    vacancy_timeout_seconds: float = float(os.getenv("SEAT_VACANCY_TIMEOUT", "300.0"))

    # Confidence score thresholds
    occupied_min_confidence: float = 0.70
    likely_available_min_confidence: float = 0.55


# ---------------------------------------------------------------------------
# Camera / Stream
# ---------------------------------------------------------------------------
@dataclass
class CameraConfig:
    # Target frames per second for processing (independent of source FPS)
    target_fps: int = int(os.getenv("CAMERA_TARGET_FPS", "15"))

    # Resize every frame to this width before detection (0 = no resize)
    frame_width: int = int(os.getenv("CAMERA_FRAME_WIDTH", "1280"))
    frame_height: int = int(os.getenv("CAMERA_FRAME_HEIGHT", "720"))

    # RTSP/MJPEG reconnect delay in seconds
    reconnect_delay: float = float(os.getenv("CAMERA_RECONNECT_DELAY", "5.0"))

    # Buffer size for the frame queue per camera
    frame_buffer_size: int = int(os.getenv("CAMERA_BUFFER_SIZE", "5"))


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------
@dataclass
class AnalyticsConfig:
    # How often (seconds) to flush analytics snapshots to the backend
    flush_interval_seconds: int = int(os.getenv("ANALYTICS_FLUSH_INTERVAL", "30"))

    # Heatmap grid resolution (rows × cols)
    heatmap_rows: int = int(os.getenv("HEATMAP_ROWS", "20"))
    heatmap_cols: int = int(os.getenv("HEATMAP_COLS", "20"))


# ---------------------------------------------------------------------------
# Redis (shared state between AI workers and backend)
# ---------------------------------------------------------------------------
@dataclass
class RedisConfig:
    host: str = os.getenv("REDIS_HOST", "localhost")
    port: int = int(os.getenv("REDIS_PORT", "6379"))
    db: int = int(os.getenv("REDIS_DB", "0"))
    password: str | None = os.getenv("REDIS_PASSWORD", None)

    @property
    def url(self) -> str:
        if self.password:
            return f"redis://:{self.password}@{self.host}:{self.port}/{self.db}"
        return f"redis://{self.host}:{self.port}/{self.db}"


# ---------------------------------------------------------------------------
# Assembled config singleton
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Assembled config singleton
# ---------------------------------------------------------------------------
# FaceReIdConfig lives in ai/reid/face_reid.py (next to the code that
# actually uses its fields) — imported here rather than duplicated, so
# there's exactly one definition instead of two that can drift apart.
from ai.reid.face_reid import FaceReIdConfig  # noqa: E402


@dataclass
class KyroConfig:
    detection: DetectionConfig = field(default_factory=DetectionConfig)
    tracking: TrackingConfig = field(default_factory=TrackingConfig)
    seats: SeatConfig = field(default_factory=SeatConfig)
    camera: CameraConfig = field(default_factory=CameraConfig)
    analytics: AnalyticsConfig = field(default_factory=AnalyticsConfig)
    redis: RedisConfig = field(default_factory=RedisConfig)
    face_reid: FaceReIdConfig = field(default_factory=FaceReIdConfig)


# Module-level singleton
config = KyroConfig()
