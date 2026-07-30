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

    # Inference settings
    confidence_threshold: float = float(os.getenv("DETECTION_CONF", "0.45"))
    iou_threshold: float = float(os.getenv("DETECTION_IOU", "0.45"))
    device: str = os.getenv("DETECTION_DEVICE", "cuda")  # "cuda" | "cpu" | "mps"

    # Only detect person class (class 0 in COCO)
    target_classes: list[int] = field(default_factory=lambda: [0])

    # Image size fed into model (must be multiple of 32)
    imgsz: int = int(os.getenv("DETECTION_IMGSZ", "640"))

    # Max detections per frame (safety limit)
    max_det: int = int(os.getenv("DETECTION_MAX_DET", "300"))


# ---------------------------------------------------------------------------
# Tracking (ByteTrack)
# ---------------------------------------------------------------------------
@dataclass
class TrackingConfig:
    # Max frames to keep a lost track alive before dropping
    max_age: int = int(os.getenv("TRACK_MAX_AGE", "30"))

    # Minimum consecutive detections before a track is confirmed
    min_hits: int = int(os.getenv("TRACK_MIN_HITS", "3"))

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
    vacancy_timeout_seconds: float = float(os.getenv("SEAT_VACANCY_TIMEOUT", "180.0"))

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
@dataclass
class KyroConfig:
    detection: DetectionConfig = field(default_factory=DetectionConfig)
    tracking: TrackingConfig = field(default_factory=TrackingConfig)
    seats: SeatConfig = field(default_factory=SeatConfig)
    camera: CameraConfig = field(default_factory=CameraConfig)
    analytics: AnalyticsConfig = field(default_factory=AnalyticsConfig)
    redis: RedisConfig = field(default_factory=RedisConfig)


# Module-level singleton
config = KyroConfig()
