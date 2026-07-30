"""
Kyro — Attendance Counter

Tracks live attendance metrics across one camera session.

Metrics:
- Current attendance (people inside now)
- Peak attendance (max at any single point)
- Total entries (cumulative people who entered)
- Total exits (cumulative people who left)
- Live occupancy percentage

Design decisions:
- Entry = a new track_id appears for the first time (confirmed state).
- Exit  = a previously seen track_id transitions to DELETED.
- Prevents double counting by maintaining a set of seen track IDs.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from ai.tracking.bytetrack import TrackedPerson

logger = logging.getLogger(__name__)


@dataclass
class AttendanceSnapshot:
    """Point-in-time attendance metrics."""
    timestamp: float
    current_attendance: int
    peak_attendance: int
    total_entries: int
    total_exits: int
    occupancy_percent: float   # 0–100, relative to venue capacity


class AttendanceCounter:
    """
    Maintains running attendance metrics for one camera/session.

    Usage:
        counter = AttendanceCounter(venue_capacity=500)
        counter.update(tracked_persons)
        snapshot = counter.snapshot()
    """

    def __init__(self, venue_capacity: int = 0) -> None:
        self._capacity = venue_capacity
        self._active_ids: set[int] = set()    # currently inside
        self._seen_ids:   set[int] = set()    # ever seen (prevent re-counting)
        self._total_entries: int = 0
        self._total_exits:   int = 0
        self._peak:           int = 0
        self._session_start = time.time()
        logger.info("AttendanceCounter started | capacity=%d", venue_capacity)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, tracked_persons: list[TrackedPerson]) -> None:
        """
        Update counts from the latest set of confirmed tracks.

        Args:
            tracked_persons: Output of ByteTracker.update() — confirmed tracks only.
        """
        current_ids = {p.track_id for p in tracked_persons}

        # New IDs = entries
        new_ids = current_ids - self._seen_ids
        self._total_entries += len(new_ids)
        self._seen_ids |= new_ids

        # IDs that vanished = exits
        exited_ids = self._active_ids - current_ids
        self._total_exits += len(exited_ids)

        self._active_ids = current_ids
        self._peak = max(self._peak, len(current_ids))

        if new_ids or exited_ids:
            logger.debug(
                "Attendance | current=%d entries=%d exits=%d peak=%d",
                len(self._active_ids),
                self._total_entries,
                self._total_exits,
                self._peak,
            )

    @property
    def current_attendance(self) -> int:
        return len(self._active_ids)

    @property
    def peak_attendance(self) -> int:
        return self._peak

    @property
    def total_entries(self) -> int:
        return self._total_entries

    @property
    def total_exits(self) -> int:
        return self._total_exits

    @property
    def occupancy_percent(self) -> float:
        if self._capacity <= 0:
            return 0.0
        return round(min(100.0, self.current_attendance / self._capacity * 100), 1)

    def snapshot(self) -> AttendanceSnapshot:
        return AttendanceSnapshot(
            timestamp=time.time(),
            current_attendance=self.current_attendance,
            peak_attendance=self.peak_attendance,
            total_entries=self.total_entries,
            total_exits=self.total_exits,
            occupancy_percent=self.occupancy_percent,
        )

    def reset(self) -> None:
        """Reset for a new service session."""
        self._active_ids.clear()
        self._seen_ids.clear()
        self._total_entries = 0
        self._total_exits = 0
        self._peak = 0
        self._session_start = time.time()
        logger.info("AttendanceCounter reset")
