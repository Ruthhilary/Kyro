"""
Kyro — Seat Model

Defines the Seat entity and its occupancy state machine.

Design decisions:
- Seats have fixed positions defined at setup time (not detected live).
- Occupancy uses a temporal state machine, NOT a simple binary classification.
- We never claim certainty — confidence scores reflect ambiguity honestly.
- A person standing up does not immediately free the seat (vacancy_timeout).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


class OccupancyState(str, Enum):
    """
    Seat occupancy states with honest uncertainty.
    """
    OCCUPIED           = "occupied"            # Person confirmed in seat
    TEMPORARILY_VACANT = "temporarily_vacant"  # Person left recently, likely returning
    LIKELY_AVAILABLE   = "likely_available"    # Vacancy timeout exceeded
    AVAILABLE          = "available"           # Confirmed no one for extended period
    UNKNOWN            = "unknown"             # Insufficient data


@dataclass
class Seat:
    """
    A single seat in the venue.

    Attributes:
        seat_id:     Unique identifier, e.g. "A-14", "BALCONY-115"
        bbox:        Fixed bounding box [x1, y1, x2, y2] in frame pixels
        row:         Row label, e.g. "A", "B", "BALCONY"
        number:      Seat number within the row
        section:     Named section, e.g. "Main Floor", "Left Balcony"
        state:       Current occupancy state
        confidence:  0.0–1.0 confidence in the current state
    """

    seat_id: str
    bbox: np.ndarray                          # shape (4,) — fixed
    row: str
    number: int
    section: str = "Main"

    # Runtime state — updated each frame
    state: OccupancyState = OccupancyState.UNKNOWN
    confidence: float = 0.0
    occupying_track_id: Optional[int] = None  # Track ID currently in this seat

    # Temporal tracking
    _last_occupied_time: Optional[float] = field(default=None, repr=False)
    _vacancy_start_time: Optional[float] = field(default=None, repr=False)
    _frames_occupied: int = field(default=0, repr=False)
    _frames_vacant: int = field(default=0, repr=False)

    # ------------------------------------------------------------------
    # State transitions
    # ------------------------------------------------------------------

    def mark_occupied(self, track_id: int, confidence: float) -> None:
        """Call when a person is detected overlapping this seat."""
        now = time.monotonic()
        self.occupying_track_id = track_id
        self._last_occupied_time = now
        self._vacancy_start_time = None
        self._frames_occupied += 1
        self._frames_vacant = 0
        self.state = OccupancyState.OCCUPIED
        self.confidence = min(confidence, 1.0)

    def mark_vacated(self, vacancy_timeout: float) -> None:
        """
        Call when no person is detected in this seat.
        Applies temporal reasoning: don't flip to available immediately.
        """
        now = time.monotonic()

        if self.state == OccupancyState.OCCUPIED:
            # Person just left — start the vacancy timer
            self._vacancy_start_time = now
            self.state = OccupancyState.TEMPORARILY_VACANT
            self.confidence = 0.60
            self.occupying_track_id = None
            self._frames_vacant = 1
            return

        if self.state == OccupancyState.TEMPORARILY_VACANT:
            elapsed = now - (self._vacancy_start_time or now)
            self._frames_vacant += 1

            if elapsed >= vacancy_timeout:
                self.state = OccupancyState.LIKELY_AVAILABLE
                self.confidence = 0.75
            else:
                # Confidence rises slowly as time passes
                ratio = elapsed / vacancy_timeout
                self.confidence = 0.60 + 0.15 * ratio
            return

        if self.state == OccupancyState.LIKELY_AVAILABLE:
            self._frames_vacant += 1
            # After 2× the timeout with no return, call it available
            elapsed = now - (self._vacancy_start_time or now)
            if elapsed >= vacancy_timeout * 2:
                self.state = OccupancyState.AVAILABLE
                self.confidence = 0.90
            return

        # AVAILABLE / UNKNOWN → just stay
        if self.state == OccupancyState.UNKNOWN:
            self._frames_vacant += 1
            if self._frames_vacant > 10:
                self.state = OccupancyState.AVAILABLE
                self.confidence = 0.85

    def reset(self) -> None:
        """Reset to unknown state (e.g., camera restart)."""
        self.state = OccupancyState.UNKNOWN
        self.confidence = 0.0
        self.occupying_track_id = None
        self._last_occupied_time = None
        self._vacancy_start_time = None
        self._frames_occupied = 0
        self._frames_vacant = 0

    # ------------------------------------------------------------------
    # Computed helpers
    # ------------------------------------------------------------------

    @property
    def center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)

    @property
    def is_available_for_usher(self) -> bool:
        """True if usher should guide someone to this seat."""
        return self.state in (
            OccupancyState.AVAILABLE,
            OccupancyState.LIKELY_AVAILABLE,
        )

    def to_dict(self) -> dict:
        return {
            "seat_id": self.seat_id,
            "row": self.row,
            "number": self.number,
            "section": self.section,
            "state": self.state.value,
            "confidence": round(self.confidence, 3),
            "occupying_track_id": self.occupying_track_id,
            "bbox": self.bbox.tolist(),
        }
