"""
Kyro — Seat Occupancy Engine

Maps tracked persons to seats using IoU overlap.
Updates each seat's state machine every frame.

Extended logic:
1. Exclusion zones (stage, front rush area, choir area):
   - Persons detected inside an exclusion zone do NOT free any seat.
   - Seats that physically overlap an exclusion zone are tagged at load time.
   - If any person is in the zone, those seats stay held.

2. Rota holds:
   - RotaManager provides which seats/rows to hold each frame.
   - Held seats transition to ROTA_HOLD instead of vacancy logic.

3. Reserved seats:
   - Seats with seat.reserved=True are never freed regardless of detection.

4. Long absence timeout:
   - Vacancy → TEMPORARILY_VACANT → (3 min) → still TEMPORARILY_VACANT
   - After 30 minutes: LIKELY_AVAILABLE (configurable via SEAT_LONG_ABSENCE_TIMEOUT)
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from ai.config import SeatConfig
from ai.seat_detection.seat import Seat, OccupancyState
from ai.seat_detection.zones import ExclusionZone
from ai.seat_detection.rota import RotaManager
from ai.tracking.bytetrack import TrackedPerson

logger = logging.getLogger(__name__)

# 30-minute long absence timeout (configurable via env)
import os
_LONG_ABSENCE_TIMEOUT = float(os.getenv("SEAT_LONG_ABSENCE_TIMEOUT", "1800.0"))


def _compute_iou(box_a: np.ndarray, box_b: np.ndarray) -> float:
    x1 = max(box_a[0], box_b[0]); y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2]); y2 = min(box_a[3], box_b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, box_a[2] - box_a[0]) * max(0.0, box_a[3] - box_a[1])
    area_b = max(0.0, box_b[2] - box_b[0]) * max(0.0, box_b[3] - box_b[1])
    union  = area_a + area_b - inter
    return float(inter / union) if union > 0 else 0.0


class SeatOccupancyEngine:
    """
    Updates seat states based on current tracked persons, exclusion zones, and rota.
    """

    def __init__(
        self,
        seats: list[Seat],
        cfg: SeatConfig,
        exclusion_zones: Optional[list[ExclusionZone]] = None,
        rota: Optional[RotaManager] = None,
    ) -> None:
        self._seats = seats
        self._cfg = cfg
        self._zones: list[ExclusionZone] = exclusion_zones or []
        self._rota: RotaManager = rota or RotaManager()
        # Zone IDs with a person currently inside them, from the most
        # recent update() call — used for reporting, since re-deriving
        # this from seat bboxes (rather than person bboxes) would answer
        # a different question entirely.
        self._last_active_zone_ids: set[str] = set()
        # Seat IDs that just transitioned INTO an available state this
        # frame (edge, not level) — i.e. the exact moment a seat first
        # became flagged as available, not every frame it remains so.
        # This is what should trigger a one-time alert with evidence, as
        # opposed to the seat's state field (which is already broadcast
        # every frame regardless via the normal seat_states messages).
        self.newly_available_seat_ids: list[str] = []

        # Tag seats that physically overlap an exclusion zone
        self._tag_exclusion_seats()

        logger.info(
            "SeatOccupancyEngine ready | seats=%d zones=%d iou=%.2f vacancy=%.0fs long_absence=%.0fs",
            len(seats), len(self._zones),
            cfg.occupancy_iou_threshold,
            cfg.vacancy_timeout_seconds,
            _LONG_ABSENCE_TIMEOUT,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, tracked_persons: list[TrackedPerson], movement_context: dict | None = None) -> None:
        """
        Main update — called every processed frame.

        movement_context: dict[track_id → MovementType] from MovementClassifier.
        Tracks classified as STAGE_MOVE or FRONT_RUSH are excluded from seat
        matching AND their seats are held (not freed).
        """
        if not self._seats:
            return

        from ai.seat_detection.movement import MovementType
        ctx = movement_context or {}

        person_bboxes = [p.bbox for p in tracked_persons]

        # ── 1. Which exclusion zones have people in them ───────────────
        active_zone_ids: set[str] = set()
        for zone in self._zones:
            if zone.any_person_inside(person_bboxes):
                active_zone_ids.add(zone.zone_id)
        self._last_active_zone_ids = active_zone_ids
        # Only "hold_seats"-type zones being active should ever cause a seat
        # to stay held — an active "ignore" zone (someone at the exit, in
        # the toilet) must not hold seats elsewhere, even seats previously
        # tagged as overlapping a *different*, hold-type zone.
        any_hold_zone_active = any(
            zone.zone_id in active_zone_ids and zone.holds_seats for zone in self._zones
        )

        zone_held_rows: set[str] = set()
        for zone in self._zones:
            if zone.zone_id in active_zone_ids and zone.holds_seats:
                zone_held_rows.update(zone.hold_seats_in_rows)

        # ── 2. Separate stage/front-rush persons from seating persons ──
        # These people count for attendance but their SEATS stay held
        stage_track_ids: set[int] = {
            tid for tid, mv in ctx.items()
            if mv in (MovementType.STAGE_MOVE, MovementType.FRONT_RUSH)
        }

        seating_persons = [
            p for p in tracked_persons
            if p.track_id not in stage_track_ids
            and not self._person_in_any_zone(p.bbox, active_zone_ids)
        ]

        # ── 3. Apply rota holds ────────────────────────────────────────
        for seat in self._seats:
            if self._rota.seat_is_held(seat.seat_id, seat.row, seat.section):
                for entry in self._rota.active_entries:
                    if entry.affects_seat(seat.seat_id, seat.row, seat.section):
                        seat.mark_rota_hold(entry.end_epoch)
                        break

        # ── 4. IoU matching — seated persons only ─────────────────────
        seat_boxes = np.stack([s.bbox for s in self._seats])

        person_boxes = (
            np.stack([p.bbox for p in seating_persons])
            if seating_persons
            else np.empty((0, 4), dtype=np.float32)
        )

        occupied_seat_indices: set[int] = set()
        used_person_indices:   set[int] = set()

        if seating_persons:
            iou_matrix = self._build_iou_matrix(seat_boxes, person_boxes)
            flat_indices = np.argsort(-iou_matrix.ravel())

            for flat_idx in flat_indices:
                s_idx, p_idx = divmod(int(flat_idx), len(seating_persons))
                if iou_matrix[s_idx, p_idx] < self._cfg.occupancy_iou_threshold:
                    break
                if s_idx in occupied_seat_indices or p_idx in used_person_indices:
                    continue
                person = seating_persons[p_idx]
                self._seats[s_idx].mark_occupied(person.track_id, person.confidence)
                occupied_seat_indices.add(s_idx)
                used_person_indices.add(p_idx)

        # ── 5. Update unmatched seats ──────────────────────────────────
        newly_available: list[str] = []
        _AVAILABLE_STATES = (OccupancyState.AVAILABLE, OccupancyState.LIKELY_AVAILABLE)
        for i, seat in enumerate(self._seats):
            if i in occupied_seat_indices:
                continue  # already updated by mark_occupied

            # Reserved — never touch
            if seat.reserved:
                continue

            # Rota hold — already handled above
            if seat.state == OccupancyState.ROTA_HOLD:
                # Let mark_vacated handle expiry check
                pass

            # Is this seat's row held by an active zone?
            row_in_zone = seat.row in zone_held_rows or seat.in_exclusion_zone
            exclusion_active_for_seat = row_in_zone and any_hold_zone_active

            state_before = seat.state
            seat.mark_vacated(
                vacancy_timeout=self._cfg.vacancy_timeout_seconds,
                long_absence_timeout=_LONG_ABSENCE_TIMEOUT,
                exclusion_zone_active=exclusion_active_for_seat,
            )
            if state_before not in _AVAILABLE_STATES and seat.state in _AVAILABLE_STATES:
                newly_available.append(seat.seat_id)
        self.newly_available_seat_ids = newly_available

        logger.debug(
            "Seat update | total=%d occupied=%d zones_active=%s",
            len(self._seats),
            len(occupied_seat_indices),
            list(active_zone_ids) or "none",
        )

    def set_exclusion_zones(self, zones: list[ExclusionZone]) -> None:
        """Hot-swap exclusion zones (called from API when admin updates zones)."""
        self._zones = zones
        self._tag_exclusion_seats()
        logger.info("Exclusion zones updated | count=%d", len(zones))

    def set_reserved(self, seat_id: str, reserved: bool, reserved_for: Optional[str] = None) -> bool:
        """Mark or unmark a seat as reserved. Returns True if seat found."""
        for seat in self._seats:
            if seat.seat_id == seat_id:
                if reserved:
                    seat.mark_reserved(reserved_for)
                else:
                    seat.reserved = False
                    seat.reserved_for = None
                    seat.reset()
                return True
        return False

    @property
    def seats(self) -> list[Seat]:
        return self._seats

    @property
    def rota(self) -> RotaManager:
        return self._rota

    @property
    def exclusion_zones(self) -> list[ExclusionZone]:
        return self._zones

    @property
    def occupancy_summary(self) -> dict:
        total     = len(self._seats)
        occupied  = sum(1 for s in self._seats if s.state == OccupancyState.OCCUPIED)
        available = sum(1 for s in self._seats if s.is_available_for_usher)
        reserved  = sum(1 for s in self._seats if s.state == OccupancyState.RESERVED)
        rota_hold = sum(1 for s in self._seats if s.state == OccupancyState.ROTA_HOLD)

        return {
            "total_seats":       total,
            "occupied":          occupied,
            "available":         available,
            "temporarily_vacant": sum(1 for s in self._seats if s.state == OccupancyState.TEMPORARILY_VACANT),
            "likely_available":  sum(1 for s in self._seats if s.state == OccupancyState.LIKELY_AVAILABLE),
            "reserved":          reserved,
            "rota_hold":         rota_hold,
            "unknown":           sum(1 for s in self._seats if s.state == OccupancyState.UNKNOWN),
            "occupancy_rate":    round(occupied / total, 3) if total > 0 else 0.0,
            "active_zones":      sorted(self._last_active_zone_ids),
        }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _tag_exclusion_seats(self) -> None:
        """Mark seats that physically overlap a "hold_seats"-type zone.

        "ignore"-type zones (exits, toilets, walkways) never tag seats,
        even if a seat happens to physically overlap one — that overlap is
        just geography, not something that should hold the seat.
        """
        for seat in self._seats:
            seat.in_exclusion_zone = any(
                zone.holds_seats and zone.contains_bbox(seat.bbox) for zone in self._zones
            )

    def _person_in_any_zone(self, bbox: np.ndarray, active_zone_ids: set[str]) -> bool:
        """True if the person is inside an active "hold_seats" zone.

        "ignore"-type zones (exits, toilets, walkways) are intentionally
        excluded here — a person standing at an exit shouldn't be treated
        any differently from anyone else for seat matching purposes, since
        the zone has no seat-holding effect at all.
        """
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        for zone in self._zones:
            if zone.zone_id in active_zone_ids and zone.holds_seats and zone.contains_point(cx, cy):
                return True
        return False

    @staticmethod
    def _build_iou_matrix(
        seat_boxes:   np.ndarray,   # (S, 4)
        person_boxes: np.ndarray,   # (P, 4)
    ) -> np.ndarray:                # (S, P)
        if person_boxes.shape[0] == 0:
            return np.zeros((seat_boxes.shape[0], 0), dtype=np.float32)

        x1 = np.maximum(seat_boxes[:, None, 0], person_boxes[None, :, 0])
        y1 = np.maximum(seat_boxes[:, None, 1], person_boxes[None, :, 1])
        x2 = np.minimum(seat_boxes[:, None, 2], person_boxes[None, :, 2])
        y2 = np.minimum(seat_boxes[:, None, 3], person_boxes[None, :, 3])

        inter = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)

        area_s = (seat_boxes[:, 2] - seat_boxes[:, 0]) * (seat_boxes[:, 3] - seat_boxes[:, 1])
        area_p = (person_boxes[:, 2] - person_boxes[:, 0]) * (person_boxes[:, 3] - person_boxes[:, 1])

        union = area_s[:, None] + area_p[None, :] - inter
        return np.where(union > 0, inter / union, 0.0).astype(np.float32)
