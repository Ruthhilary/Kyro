"""
Kyro — Seat Occupancy Engine

Maps tracked persons to seats using IoU overlap.
Updates each seat's state machine every frame.

Design decisions:
- One tracked person can only occupy one seat at a time.
- One seat can only be occupied by one person at a time.
- IoU overlap must exceed threshold — partial overlaps are ignored.
- Uses greedy assignment (best IoU first) to resolve conflicts.
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from ai.config import SeatConfig
from ai.seat_detection.seat import Seat, OccupancyState
from ai.tracking.bytetrack import TrackedPerson

logger = logging.getLogger(__name__)


def _compute_iou(box_a: np.ndarray, box_b: np.ndarray) -> float:
    """Compute IoU between two [x1,y1,x2,y2] boxes."""
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])

    inter_w = max(0.0, x2 - x1)
    inter_h = max(0.0, y2 - y1)
    inter = inter_w * inter_h

    area_a = max(0.0, box_a[2] - box_a[0]) * max(0.0, box_a[3] - box_a[1])
    area_b = max(0.0, box_b[2] - box_b[0]) * max(0.0, box_b[3] - box_b[1])
    union = area_a + area_b - inter

    return float(inter / union) if union > 0 else 0.0


class SeatOccupancyEngine:
    """
    Updates seat states based on current tracked persons.

    Usage:
        engine = SeatOccupancyEngine(seats, cfg)
        engine.update(tracked_persons)  # called every frame
    """

    def __init__(self, seats: list[Seat], cfg: SeatConfig) -> None:
        self._seats = seats
        self._cfg = cfg
        logger.info(
            "SeatOccupancyEngine ready | seats=%d iou_thresh=%.2f vacancy_timeout=%.0fs",
            len(seats),
            cfg.occupancy_iou_threshold,
            cfg.vacancy_timeout_seconds,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, tracked_persons: list[TrackedPerson]) -> None:
        """
        Match tracked persons to seats and update each seat's state.

        Args:
            tracked_persons: Output from ByteTracker.update() for this frame.
        """
        if not self._seats:
            return

        # Build IoU matrix: shape (num_seats, num_persons)
        seat_boxes  = np.stack([s.bbox for s in self._seats])         # (S, 4)
        person_boxes = (
            np.stack([p.bbox for p in tracked_persons])
            if tracked_persons else np.empty((0, 4), dtype=np.float32)
        )

        occupied_seats: set[int] = set()   # seat indices matched this frame
        used_persons:   set[int] = set()   # person indices already assigned

        if tracked_persons:
            iou_matrix = self._build_iou_matrix(seat_boxes, person_boxes)  # (S, P)

            # Greedy assignment: best IoU first
            flat_indices = np.argsort(-iou_matrix.ravel())
            for flat_idx in flat_indices:
                s_idx, p_idx = divmod(int(flat_idx), len(tracked_persons))
                if iou_matrix[s_idx, p_idx] < self._cfg.occupancy_iou_threshold:
                    break  # All remaining IoUs are below threshold
                if s_idx in occupied_seats or p_idx in used_persons:
                    continue
                # Assign person to seat
                person = tracked_persons[p_idx]
                self._seats[s_idx].mark_occupied(person.track_id, person.confidence)
                occupied_seats.add(s_idx)
                used_persons.add(p_idx)

        # Update unmatched seats (vacated logic)
        for i, seat in enumerate(self._seats):
            if i not in occupied_seats:
                seat.mark_vacated(self._cfg.vacancy_timeout_seconds)

        logger.debug(
            "Seat update | total=%d occupied=%d available=%d",
            len(self._seats),
            len(occupied_seats),
            sum(1 for s in self._seats if s.is_available_for_usher),
        )

    @property
    def seats(self) -> list[Seat]:
        return self._seats

    @property
    def occupancy_summary(self) -> dict:
        total = len(self._seats)
        occupied = sum(1 for s in self._seats if s.state == OccupancyState.OCCUPIED)
        available = sum(1 for s in self._seats if s.is_available_for_usher)
        unknown = sum(1 for s in self._seats if s.state == OccupancyState.UNKNOWN)

        return {
            "total_seats": total,
            "occupied": occupied,
            "available": available,
            "temporarily_vacant": sum(
                1 for s in self._seats
                if s.state == OccupancyState.TEMPORARILY_VACANT
            ),
            "likely_available": sum(
                1 for s in self._seats
                if s.state == OccupancyState.LIKELY_AVAILABLE
            ),
            "unknown": unknown,
            "occupancy_rate": round(occupied / total, 3) if total > 0 else 0.0,
        }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_iou_matrix(
        seat_boxes: np.ndarray,    # (S, 4)
        person_boxes: np.ndarray,  # (P, 4)
    ) -> np.ndarray:               # (S, P)
        if person_boxes.shape[0] == 0:
            return np.zeros((seat_boxes.shape[0], 0), dtype=np.float32)

        x1 = np.maximum(seat_boxes[:, None, 0], person_boxes[None, :, 0])
        y1 = np.maximum(seat_boxes[:, None, 1], person_boxes[None, :, 1])
        x2 = np.minimum(seat_boxes[:, None, 2], person_boxes[None, :, 2])
        y2 = np.minimum(seat_boxes[:, None, 3], person_boxes[None, :, 3])

        inter = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)

        area_s = ((seat_boxes[:, 2] - seat_boxes[:, 0]) *
                  (seat_boxes[:, 3] - seat_boxes[:, 1]))   # (S,)
        area_p = ((person_boxes[:, 2] - person_boxes[:, 0]) *
                  (person_boxes[:, 3] - person_boxes[:, 1]))  # (P,)

        union = area_s[:, None] + area_p[None, :] - inter
        iou = np.where(union > 0, inter / union, 0.0)

        return iou.astype(np.float32)
