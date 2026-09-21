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
from typing import Optional

import numpy as np

from ai.analytics.counter import AttendanceCounter, AttendanceSnapshot
from ai.config import KyroConfig
from ai.detection.detector import PersonDetector
from ai.reid.face_reid import FaceReId
from ai.seat_detection.occupancy import SeatOccupancyEngine
from ai.seat_detection.seat import Seat
from ai.seat_detection.movement import MovementClassifier, MovementType
from ai.tracking.bytetrack import ByteTracker, TrackedPerson

logger = logging.getLogger(__name__)


@dataclass
class PipelineResult:
    """Full output of one processed frame."""
    camera_id: str
    frame_number: int
    timestamp: float
    tracked_persons: list[TrackedPerson]
    attendance: AttendanceSnapshot
    seat_states: list[dict]
    inference_ms: float
    total_ms: float
    # Movement classifications for this frame (track_id → movement type)
    movement_context: dict[int, str] = field(default_factory=dict)
    # Seat IDs that just became available THIS frame (edge, not level) —
    # see SeatOccupancyEngine.newly_available_seat_ids. The worker uses
    # this to capture a one-time evidence snapshot and raise an alert,
    # rather than firing every frame a seat merely remains available.
    newly_available_seat_ids: list[str] = field(default_factory=list)


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

        self._detector    = PersonDetector(cfg.detection)
        self._tracker     = ByteTracker(cfg.tracking)
        self._seat_engine = SeatOccupancyEngine(seats, cfg.seats)
        self._counter     = AttendanceCounter(venue_capacity)
        self._face_reid   = FaceReId(cfg.face_reid)
        self._movement    = MovementClassifier(
            stage_bboxes=[],
            camera_id=camera_id,
            frame_width=cfg.camera.frame_width or 1280,
            frame_height=cfg.camera.frame_height or 720,
        )

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

        # Stage 1.5: Camera-calibration scale sanity check. The re-id
        # module learns "expected bbox height at this y-position" for
        # this fixed camera online, from real observations, as it runs.
        # A detection wildly the wrong size for its position (e.g. way
        # too small/large to plausibly be a person standing/sitting
        # there) is more likely a misdetected object than a real person.
        # Deliberately conservative — only rejects extreme deviations,
        # and only once there's enough calibration data to trust; when in
        # doubt, we keep the detection (a missed real person is worse
        # than an occasional false positive slipping through here, since
        # later stages — min_hits confirmation, tracking — filter more).
        detections = self._filter_by_scale_plausibility(detections, frame.shape[0])

        # Stage 2: Track persons
        tracked_persons = self._tracker.update(detections)

        # Stage 2.5: Classify movement context BEFORE occupancy update.
        # Refresh the movement classifier's stage zones FIRST so that if
        # zones changed (e.g. an admin just edited them), classification
        # this frame uses the current zones rather than last frame's.
        # Only "hold_seats"-type zones (stage/altar/choir) count as "stage"
        # for movement classification. "ignore"-type zones (exit, toilet)
        # must NOT make someone walking there look like a stage move.
        stage_bboxes = [z.bbox for z in self._seat_engine.exclusion_zones if z.holds_seats]
        self._movement.update_stage_zones(stage_bboxes)

        rota_ids  = self._seat_engine.rota.get_held_seat_ids()
        rota_rows = self._seat_engine.rota.get_held_rows()
        movement_context = self._movement.update(tracked_persons, rota_ids, rota_rows)

        # Stage 3: Update seat occupancy (passes movement context through engine)
        self._seat_engine.update(tracked_persons, movement_context=movement_context)

        # Stage 4: Face re-id — resolve each confirmed track to a stable
        # identity, so a person returning after a brief absence (e.g. a
        # toilet break, where the tracker assigns a new track_id) is
        # recognised as the same person rather than counted as new.
        identity_map = {
            p.track_id: self._face_reid.resolve(p.track_id, frame, p.bbox)[0]
            for p in tracked_persons
        }
        # Tracks that are LOST (occluded, within ByteTrack's grace period)
        # aren't in tracked_persons this frame, so they wouldn't get an
        # entry above — but still_tracked_ids (passed to the counter below)
        # includes them. Fill those in from FaceReId's cache rather than
        # leaving them unmapped, otherwise a brief occlusion would look
        # like the original identity "exited" — the same class of bug as
        # the raw-track_id version of this fix.
        for track_id in self._tracker.active_track_ids:
            if track_id not in identity_map:
                cached = self._face_reid.get_cached_identity(track_id)
                if cached is not None:
                    identity_map[track_id] = cached

        # Stage 5: Update attendance counter (pass the tracker's full
        # CONFIRMED+LOST set so brief occlusions aren't counted as exits,
        # and identity_map so face re-id prevents double-counting returns)
        self._counter.update(
            tracked_persons,
            still_tracked_ids=self._tracker.active_track_ids,
            identity_map=identity_map,
        )

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
            movement_context={tid: m.value for tid, m in movement_context.items()},
            newly_available_seat_ids=list(self._seat_engine.newly_available_seat_ids),
        )

    def get_seat_bbox(self, seat_id: str) -> Optional[np.ndarray]:
        """Look up a seat's fixed bbox by ID — used by the worker to crop
        an evidence snapshot when that seat becomes available."""
        for seat in self._seat_engine.seats:
            if seat.seat_id == seat_id:
                return seat.bbox
        return None

    def _filter_by_scale_plausibility(self, detections: list, frame_h: int) -> list:
        """
        Drop detections whose bbox size is extremely implausible for a
        human at that position, per the re-id module's learned camera
        calibration. Conservative by design — see call site comment.
        """
        if frame_h <= 0:
            return detections
        kept = []
        for det in detections:
            y1, y2 = det.bbox[1], det.bbox[3]
            cy_norm = ((y1 + y2) / 2) / frame_h
            bbox_height = float(y2 - y1)
            expected = self._face_reid.expected_scale_at(cy_norm)
            if expected is None or expected <= 0:
                kept.append(det)  # not enough calibration data yet — don't filter
                continue
            ratio = bbox_height / expected
            if 0.35 <= ratio <= 3.0:
                kept.append(det)
            # else: dropped — implausible scale for this position
        return kept

    def reset_session(self) -> None:
        """Call at the start of a new service to reset counts."""
        self._counter.reset()
        for seat in self._seat_engine.seats:
            seat.reset()
        # Wipe face fingerprints too — a new service shouldn't inherit
        # identities from whoever attended a previous one.
        self._face_reid.reset()
        logger.info("Pipeline session reset | camera_id=%s", self.camera_id)
