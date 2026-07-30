"""
Kyro — ByteTrack Multi-Object Tracker

Implements a simplified ByteTrack algorithm for robust person tracking.
Assigns persistent temporary IDs to each person while preventing double counting.

Design decisions:
- Two-stage matching: high-confidence detections first, then low-confidence.
- Kalman filter for motion prediction between frames.
- Tracks are CONFIRMED only after min_hits consecutive detections.
- Lost tracks are kept alive for max_age frames before deletion.
- No biometric data is stored — tracking IDs are session-only.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional

import numpy as np
from filterpy.kalman import KalmanFilter

from ai.config import TrackingConfig
from ai.detection.detector import Detection

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Track state machine
# ---------------------------------------------------------------------------

class TrackState(Enum):
    TENTATIVE = auto()   # Not yet confirmed (< min_hits)
    CONFIRMED = auto()   # Actively tracked
    LOST = auto()        # Not matched this frame, kept alive
    DELETED = auto()     # Exceeded max_age, ready for removal


# ---------------------------------------------------------------------------
# Kalman filter factory
# ---------------------------------------------------------------------------

def _build_kalman_filter(bbox_tlwh: np.ndarray) -> KalmanFilter:
    """
    Constant-velocity Kalman filter for bounding-box tracking.

    State vector: [cx, cy, aspect_ratio, height, vx, vy, va, vh]
    Measurement:  [cx, cy, aspect_ratio, height]
    """
    kf = KalmanFilter(dim_x=8, dim_z=4)

    # Transition matrix (constant velocity model)
    kf.F = np.eye(8)
    for i in range(4):
        kf.F[i, i + 4] = 1.0

    # Measurement matrix (observe position only)
    kf.H = np.eye(4, 8)

    # Measurement noise
    kf.R[2:, 2:] *= 10.0

    # Covariance matrix
    kf.P[4:, 4:] *= 1000.0
    kf.P *= 10.0

    # Process noise
    kf.Q[-1, -1] *= 0.01
    kf.Q[4:, 4:] *= 0.01

    # Initial state from detection
    x1, y1, w, h = bbox_tlwh
    cx = x1 + w / 2
    cy = y1 + h / 2
    aspect = w / float(h) if h > 0 else 1.0
    kf.x[:4] = np.array([[cx], [cy], [aspect], [h]])

    return kf


def _tlwh_to_measurement(bbox_tlwh: np.ndarray) -> np.ndarray:
    x1, y1, w, h = bbox_tlwh
    cx = x1 + w / 2
    cy = y1 + h / 2
    aspect = w / float(h) if h > 0 else 1.0
    return np.array([[cx], [cy], [aspect], [h]])


def _state_to_tlwh(kf: KalmanFilter) -> np.ndarray:
    cx, cy, aspect, h = kf.x[:4].flatten()
    w = aspect * h
    return np.array([cx - w / 2, cy - h / 2, w, h], dtype=np.float32)


def _tlwh_to_xyxy(tlwh: np.ndarray) -> np.ndarray:
    x1, y1, w, h = tlwh
    return np.array([x1, y1, x1 + w, y1 + h], dtype=np.float32)


# ---------------------------------------------------------------------------
# Single track
# ---------------------------------------------------------------------------

class Track:
    """Represents one tracked person across frames."""

    _id_counter: int = 0

    def __init__(self, detection: Detection, cfg: TrackingConfig) -> None:
        Track._id_counter += 1
        self.track_id: int = Track._id_counter
        self.state: TrackState = TrackState.TENTATIVE
        self.hits: int = 1
        self.age: int = 0          # frames since last match
        self.confidence: float = detection.confidence
        self._cfg = cfg

        tlwh = detection.to_tlwh()
        self._kf = _build_kalman_filter(tlwh)

    # ------------------------------------------------------------------
    # Kalman operations
    # ------------------------------------------------------------------

    def predict(self) -> None:
        """Advance state estimate by one frame."""
        self._kf.predict()
        self.age += 1

    def update(self, detection: Detection) -> None:
        """Update track with a matched detection."""
        measurement = _tlwh_to_measurement(detection.to_tlwh())
        self._kf.update(measurement)
        self.confidence = detection.confidence
        self.hits += 1
        self.age = 0

        if self.state == TrackState.LOST:
            self.state = TrackState.CONFIRMED
        elif self.state == TrackState.TENTATIVE and self.hits >= self._cfg.min_hits:
            self.state = TrackState.CONFIRMED

    def mark_lost(self) -> None:
        self.state = TrackState.LOST

    def mark_deleted(self) -> None:
        self.state = TrackState.DELETED

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def bbox_tlwh(self) -> np.ndarray:
        return _state_to_tlwh(self._kf)

    @property
    def bbox_xyxy(self) -> np.ndarray:
        return _tlwh_to_xyxy(self.bbox_tlwh)

    @property
    def is_confirmed(self) -> bool:
        return self.state == TrackState.CONFIRMED

    @property
    def is_deleted(self) -> bool:
        return self.state == TrackState.DELETED

    def __repr__(self) -> str:
        return f"Track(id={self.track_id}, state={self.state.name}, hits={self.hits})"


# ---------------------------------------------------------------------------
# IoU helpers
# ---------------------------------------------------------------------------

def _iou_matrix(tracks: list[Track], detections: list[Detection]) -> np.ndarray:
    """
    Compute IoU between every track prediction and every detection.
    Returns shape (len(tracks), len(detections)).
    """
    if not tracks or not detections:
        return np.zeros((len(tracks), len(detections)), dtype=np.float32)

    track_boxes = np.stack([t.bbox_xyxy for t in tracks])        # (T, 4)
    det_boxes = np.stack([d.bbox for d in detections])           # (D, 4)

    # Broadcast intersection
    x1 = np.maximum(track_boxes[:, None, 0], det_boxes[None, :, 0])
    y1 = np.maximum(track_boxes[:, None, 1], det_boxes[None, :, 1])
    x2 = np.minimum(track_boxes[:, None, 2], det_boxes[None, :, 2])
    y2 = np.minimum(track_boxes[:, None, 3], det_boxes[None, :, 3])

    inter = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)  # (T, D)

    area_t = ((track_boxes[:, 2] - track_boxes[:, 0]) *
              (track_boxes[:, 3] - track_boxes[:, 1]))             # (T,)
    area_d = ((det_boxes[:, 2] - det_boxes[:, 0]) *
              (det_boxes[:, 3] - det_boxes[:, 1]))                 # (D,)

    union = area_t[:, None] + area_d[None, :] - inter
    iou = np.where(union > 0, inter / union, 0.0)

    return iou.astype(np.float32)


def _greedy_match(cost_matrix: np.ndarray, threshold: float) -> list[tuple[int, int]]:
    """
    Greedy assignment: match each row to the best available column if
    the cost (IoU) exceeds the threshold.
    """
    matches: list[tuple[int, int]] = []
    if cost_matrix.size == 0:
        return matches

    used_cols: set[int] = set()
    # Sort by descending IoU to take best matches first
    row_order = np.argsort(-cost_matrix.max(axis=1))

    for row in row_order:
        best_col = int(np.argmax(cost_matrix[row]))
        if best_col in used_cols:
            continue
        if cost_matrix[row, best_col] >= threshold:
            matches.append((row, best_col))
            used_cols.add(best_col)

    return matches


# ---------------------------------------------------------------------------
# ByteTrack tracker
# ---------------------------------------------------------------------------

@dataclass
class TrackedPerson:
    """Public output type: one confirmed tracked person per frame."""
    track_id: int
    bbox: np.ndarray      # [x1, y1, x2, y2]
    confidence: float
    state: TrackState


class ByteTracker:
    """
    ByteTrack-style multi-object tracker for person tracking.

    Two-stage matching:
    1. High-confidence detections → existing confirmed + lost tracks
    2. Low-confidence detections  → remaining unmatched tracks

    Usage:
        tracker = ByteTracker(cfg)
        tracked = tracker.update(detections)
    """

    def __init__(self, cfg: TrackingConfig) -> None:
        self._cfg = cfg
        self._tracks: list[Track] = []
        self._frame_count: int = 0
        # Reset class-level ID counter when tracker is re-instantiated
        Track._id_counter = 0
        logger.info("ByteTracker initialised | max_age=%d min_hits=%d", cfg.max_age, cfg.min_hits)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, detections: list[Detection]) -> list[TrackedPerson]:
        """
        Process one frame of detections and return confirmed tracked persons.

        Args:
            detections: All detections from PersonDetector for this frame.

        Returns:
            List of TrackedPerson for every confirmed, active track.
        """
        self._frame_count += 1

        # 1. Predict next state for every existing track
        for track in self._tracks:
            track.predict()

        # 2. Split detections by confidence
        high_dets = [d for d in detections if d.confidence >= self._cfg.high_thresh]
        low_dets  = [d for d in detections if self._cfg.low_thresh <= d.confidence < self._cfg.high_thresh]

        # 3. Stage 1: match high-confidence dets to confirmed + lost tracks
        confirmed_tracks = [t for t in self._tracks if t.state in (TrackState.CONFIRMED, TrackState.LOST)]
        tentative_tracks = [t for t in self._tracks if t.state == TrackState.TENTATIVE]

        matches1, unmatched_tracks1, unmatched_dets1 = self._match(confirmed_tracks, high_dets)

        for t_idx, d_idx in matches1:
            confirmed_tracks[t_idx].update(high_dets[d_idx])

        # 4. Stage 2: match low-confidence dets to remaining unmatched tracks
        remaining_tracks = [confirmed_tracks[i] for i in unmatched_tracks1]
        matches2, unmatched_tracks2, _ = self._match(remaining_tracks, low_dets)

        for t_idx, d_idx in matches2:
            remaining_tracks[t_idx].update(low_dets[d_idx])

        # 5. Mark truly unmatched confirmed tracks as LOST
        still_unmatched = {remaining_tracks[i].track_id for i in unmatched_tracks2}
        for track in confirmed_tracks:
            if track.track_id in still_unmatched:
                track.mark_lost()

        # 6. Stage 3: match unmatched high-conf dets to tentative tracks
        unmatched_high_dets = [high_dets[i] for i in unmatched_dets1]
        matches3, _, unmatched_dets3 = self._match(tentative_tracks, unmatched_high_dets)

        for t_idx, d_idx in matches3:
            tentative_tracks[t_idx].update(unmatched_high_dets[d_idx])

        # 7. Delete stale tracks
        for track in self._tracks:
            if track.state == TrackState.LOST and track.age > self._cfg.max_age:
                track.mark_deleted()

        self._tracks = [t for t in self._tracks if not t.is_deleted]

        # 8. Initialise new tracks from unmatched high-confidence detections
        for d_idx in unmatched_dets3:
            new_track = Track(unmatched_high_dets[d_idx], self._cfg)
            self._tracks.append(new_track)

        # 9. Return only confirmed tracks
        output: list[TrackedPerson] = [
            TrackedPerson(
                track_id=t.track_id,
                bbox=t.bbox_xyxy.copy(),
                confidence=t.confidence,
                state=t.state,
            )
            for t in self._tracks
            if t.is_confirmed
        ]

        logger.debug(
            "Frame %d | detections=%d confirmed_tracks=%d total_tracks=%d",
            self._frame_count, len(detections), len(output), len(self._tracks),
        )

        return output

    @property
    def active_count(self) -> int:
        """Number of currently confirmed tracks."""
        return sum(1 for t in self._tracks if t.is_confirmed)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _match(
        self,
        tracks: list[Track],
        detections: list[Detection],
    ) -> tuple[list[tuple[int, int]], list[int], list[int]]:
        """
        Match tracks to detections using IoU.
        Returns (matches, unmatched_track_indices, unmatched_detection_indices).
        """
        iou = _iou_matrix(tracks, detections)
        matches = _greedy_match(iou, self._cfg.iou_threshold)

        matched_t = {m[0] for m in matches}
        matched_d = {m[1] for m in matches}

        unmatched_tracks = [i for i in range(len(tracks)) if i not in matched_t]
        unmatched_dets   = [i for i in range(len(detections)) if i not in matched_d]

        return matches, unmatched_tracks, unmatched_dets
