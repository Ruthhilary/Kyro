"""
Kyro — Vision Pipeline

Orchestrates the full AI pipeline for one camera stream:
  Frame → Detection → Tracking → Seat Occupancy → Attendance Counter → Output

Design decisions:
- Single responsibility per module: pipeline only orchestrates, never detects/tracks itself.
- Output is a PipelineResult dataclass — clean interface for the backend to consume.
- Frame skipping is built in to maintain target FPS under load.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import numpy as np

from ai.analytics.counter import AttendanceCounter, AttendanceSnapshot
from ai.config import KyroConfig
from ai.detection.detector import PersonDetector
from ai.seat_detection.occupancy import SeatOccupancyEngine
from ai.seat_detection.seat import Seat
from ai.tracking.bytetrack import ByteTracker, TrackedPerson

logger = logging.getLogger(__name__)


@dataclass
class PipelineResult:
    """Full output of one processed frame."""
    camera_id: str
    frame_number: int
    timestamp: float

    # Tracked persons (confirmed tracks only)
    tracked_persons: list[TrackedPerson]

    # Attendance snapshot
    attendance: AttendanceSnapshot

    # Seat states (serialisable)
    seat_states: list[dict]

    # Processing time in milliseconds
    inference_ms: float
    total_ms: float


class VisionPipeline:
    """
    End-to-end vision pipeline for one camera feed.

    Usage:
        pipeline = VisionPipeline(camera_id="cam-01", seats=seats, cfg=config)
        result = pipeline.process_frame(bgr_frame)
    """

    def __init__(
        self,
        camera_id: str,
        seats: list[Seat],
        cfg: KyroConfig,
        venue_capacity: int = 0,
    ) -> None:
        self.camera_id = camera_id
        self._cfg = cfg
        self._frame_number = 0

        # Initialise pipeline stages
        self._detector  = PersonDetector(cfg.detection)
        self._tracker   = ByteTracker(cfg.tracking)
        self._seat_engine = SeatOccupancyEngine(seats, cfg.seats)
        self._counter   = AttendanceCounter(venue_capacity)

        logger.info("VisionPipeline ready | camera_id=%s seats=%d", camera_id, len(seats))

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process_frame(self, frame: np.ndarray) -> PipelineResult:
        """
        Process a single BGR frame through the full pipeline.

        Args:
            frame: H×W×3 numpy array from OpenCV capture.

        Returns:
            PipelineResult with all metrics for this frame.
        """
        t_start = time.perf_counter()
        self._frame_number += 1

        # Stage 1: Detect persons
        t_detect = time.perf_counter()
        detections = self._detector.detect(frame)
        inference_ms = (time.perf_counter() - t_detect) * 1000

        # Stage 2: Track persons
        tracked_persons = self._tracker.update(detections)

        # Stage 3: Update seat occupancy
        self._seat_engine.update(tracked_persons)

        # Stage 4: Update attendance counter
        self._counter.update(tracked_persons)

        total_ms = (time.perf_counter() - t_start) * 1000

        return PipelineResult(
            camera_id=self.camera_id,
            frame_number=self._frame_number,
            timestamp=time.time(),
            tracked_persons=tracked_persons,
            attendance=self._counter.snapshot(),
            seat_states=[s.to_dict() for s in self._seat_engine.seats],
            inference_ms=round(inference_ms, 2),
            total_ms=round(total_ms, 2),
        )

    def reset_session(self) -> None:
        """Call at the start of a new service to reset counts."""
        self._counter.reset()
        for seat in self._seat_engine.seats:
            seat.reset()
        logger.info("Pipeline session reset | camera_id=%s", self.camera_id)
