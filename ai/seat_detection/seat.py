"""
Kyro — Seat Model

Defines the Seat entity and its occupancy state machine.

Extended states:
- RESERVED:     Seat is reserved (physical sign, pastor's seat, VIP) — never available.
- ROTA_HOLD:    Person is on stage per rota — seat held until rota window ends.
- STAGE_AREA:   Seat is inside a stage/front exclusion zone — ignore vacancies.

Design decisions:
- A person detected in a stage/exclusion zone does NOT free any seat.
- Reserved seats never transition away from RESERVED, regardless of detection.
- Rota hold respects a time window; once the window ends, normal timeout resumes.
- 30-minute toilet absence is handled by long_absence_timeout (default 1800s).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


class OccupancyState(str, Enum):
    OCCUPIED           = "occupied"             # Person confirmed in seat
    TEMPORARILY_VACANT = "temporarily_vacant"   # Left recently, likely returning
    LIKELY_AVAILABLE   = "likely_available"     # Vacancy timeout exceeded
    AVAILABLE          = "available"            # Confirmed empty for extended period
    RESERVED           = "reserved"             # Pre-marked reserved (sign / pastor / VIP)
    ROTA_HOLD          = "rota_hold"            # Person on stage per rota, seat held
    UNKNOWN            = "unknown"              # Insufficient data


# Vacancy timeout defaults (seconds)
_DEFAULT_VACANCY_TIMEOUT      = 300.0    # 5 min — short absence before "Away" timer starts
_DEFAULT_LONG_ABSENCE_TIMEOUT = 1800.0   # 30 min — long absence before seat becomes free


@dataclass
class Seat:
    """
    A single seat in the venue.

    Extra fields vs. base version:
        reserved:           If True, seat is permanently held (reserved sign / pastor).
        reserved_for:       Optional name or label shown in UI (e.g. "Pastor John").
        in_exclusion_zone:  True if seat bbox overlaps a stage/front exclusion zone.
                            The occupancy engine will never free this seat while
                            people are detected in the exclusion zone.
        rota_hold_until:    epoch timestamp; while now() < rota_hold_until, state = ROTA_HOLD.
    """

    seat_id: str
    bbox: np.ndarray          # shape (4,) — fixed [x1,y1,x2,y2]
    row: str
    number: int
    section: str = "Main"

    # ── Policy flags ──────────────────────────────────────────────────
    reserved: bool = False
    reserved_for: Optional[str] = None   # display label e.g. "Pastor John"
    in_exclusion_zone: bool = False      # overlaps a stage / front-rush zone

    # ── Runtime state ─────────────────────────────────────────────────
    state: OccupancyState = OccupancyState.UNKNOWN
    confidence: float = 0.0
    occupying_track_id: Optional[int] = None

    # ── Temporal tracking ─────────────────────────────────────────────
    _last_occupied_time:  Optional[float] = field(default=None, repr=False)
    _vacancy_start_time:  Optional[float] = field(default=None, repr=False)
    _frames_occupied:     int = field(default=0, repr=False)
    _frames_vacant:       int = field(default=0, repr=False)
    _rota_hold_until:     Optional[float] = field(default=None, repr=False)

    # ------------------------------------------------------------------
    # State transitions
    # ------------------------------------------------------------------

    def mark_reserved(self, reserved_for: Optional[str] = None) -> None:
        """Permanently mark a seat as reserved. AI will never free it."""
        self.reserved = True
        self.reserved_for = reserved_for
        self.state = OccupancyState.RESERVED
        self.confidence = 1.0
        self.occupying_track_id = None

    def mark_rota_hold(self, hold_until_epoch: float) -> None:
        """
        Hold this seat because its occupant is on stage per the service rota.
        The seat stays ROTA_HOLD until hold_until_epoch; then normal detection resumes.
        """
        self._rota_hold_until = hold_until_epoch
        self.state = OccupancyState.ROTA_HOLD
        self.confidence = 1.0

    def release_rota_hold(self) -> None:
        """Call when the rota window ends to resume normal detection."""
        self._rota_hold_until = None
        # Treat the seat as temporarily vacant so timeout logic kicks in
        self._vacancy_start_time = time.monotonic()
        self.state = OccupancyState.TEMPORARILY_VACANT
        self.confidence = 0.60

    def mark_occupied(self, track_id: int, confidence: float) -> None:
        """Call when a person is detected overlapping this seat."""
        # Reserved seats stay reserved even if someone sits in them
        if self.reserved:
            return
        # Rota hold: if the window hasn't expired, keep the hold state
        if self._rota_hold_until and time.time() < self._rota_hold_until:
            return

        now = time.monotonic()
        self.occupying_track_id = track_id
        self._last_occupied_time = now
        self._vacancy_start_time = None
        self._frames_occupied += 1
        self._frames_vacant = 0
        self.state = OccupancyState.OCCUPIED
        self.confidence = min(confidence, 1.0)

    def mark_vacated(
        self,
        vacancy_timeout: float = _DEFAULT_VACANCY_TIMEOUT,
        long_absence_timeout: float = _DEFAULT_LONG_ABSENCE_TIMEOUT,
        exclusion_zone_active: bool = False,
    ) -> None:
        """
        Call when no person is detected in this seat.

        Args:
            vacancy_timeout:       Short absence timeout (default 3 min).
            long_absence_timeout:  Long absence before LIKELY_AVAILABLE (default 30 min).
            exclusion_zone_active: If True, someone is in the stage/front zone nearby
                                   — do NOT transition to available.
        """
        # Policy overrides — never free these
        if self.reserved:
            return
        if self._rota_hold_until:
            if time.time() < self._rota_hold_until:
                return                 # rota still active
            else:
                self.release_rota_hold()
                return

        # If the seat is in an exclusion zone AND someone is active in that zone,
        # treat it as if someone is still sitting there.
        if self.in_exclusion_zone and exclusion_zone_active:
            # Keep current occupied/temporarily-vacant state frozen
            if self.state in (OccupancyState.OCCUPIED, OccupancyState.TEMPORARILY_VACANT):
                return

        now = time.monotonic()

        if self.state == OccupancyState.OCCUPIED:
            self._vacancy_start_time = now
            self.state = OccupancyState.TEMPORARILY_VACANT
            self.confidence = 0.65
            self.occupying_track_id = None
            self._frames_vacant = 1
            return

        if self.state == OccupancyState.TEMPORARILY_VACANT:
            elapsed = now - (self._vacancy_start_time or now)
            self._frames_vacant += 1
            if elapsed >= long_absence_timeout:
                # 30+ minutes — seat is genuinely available
                self.state = OccupancyState.LIKELY_AVAILABLE
                self.confidence = 0.80
            elif elapsed >= vacancy_timeout:
                # 3–30 min — still temporarily vacant but with rising confidence
                ratio = min(1.0, (elapsed - vacancy_timeout) / (long_absence_timeout - vacancy_timeout))
                self.confidence = 0.65 + 0.15 * ratio
            return

        if self.state == OccupancyState.LIKELY_AVAILABLE:
            self._frames_vacant += 1
            elapsed = now - (self._vacancy_start_time or now)
            if elapsed >= long_absence_timeout * 2:
                self.state = OccupancyState.AVAILABLE
                self.confidence = 0.92
            return

        if self.state == OccupancyState.UNKNOWN:
            self._frames_vacant += 1
            if self._frames_vacant > 10:
                self.state = OccupancyState.AVAILABLE
                self.confidence = 0.85

    def reset(self) -> None:
        """Reset to unknown state (e.g. camera restart)."""
        if self.reserved:
            return  # reserved seats never reset
        self.state = OccupancyState.UNKNOWN
        self.confidence = 0.0
        self.occupying_track_id = None
        self._last_occupied_time = None
        self._vacancy_start_time = None
        self._frames_occupied = 0
        self._frames_vacant = 0
        self._rota_hold_until = None

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @property
    def center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)

    @property
    def is_available_for_usher(self) -> bool:
        return self.state in (OccupancyState.AVAILABLE, OccupancyState.LIKELY_AVAILABLE)

    def to_dict(self) -> dict:
        # Calculate how long this seat has been vacant (seconds), for UI timer
        vacancy_secs: float = 0.0
        if self.state in (OccupancyState.TEMPORARILY_VACANT, OccupancyState.LIKELY_AVAILABLE):
            if self._vacancy_start_time is not None:
                import time as _time
                vacancy_secs = round(_time.monotonic() - self._vacancy_start_time, 0)

        return {
            "seat_id":            self.seat_id,
            "row":                self.row,
            "number":             self.number,
            "section":            self.section,
            "state":              self.state.value,
            "confidence":         round(self.confidence, 3),
            "occupying_track_id": self.occupying_track_id,
            "bbox":               self.bbox.tolist(),
            "reserved":           self.reserved,
            "reserved_for":       self.reserved_for,
            "in_exclusion_zone":  self.in_exclusion_zone,
            "vacancy_seconds":    vacancy_secs,
        }
