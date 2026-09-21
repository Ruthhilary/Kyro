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
from typing import Optional

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
        # Note: these hold track_ids (int) normally, or identity strings
        # (e.g. "face:3") when a FaceReId identity_map is passed to
        # update() — Python sets/dicts don't care which, as long as it's
        # used consistently within one AttendanceCounter instance.
        self._active_ids: set = set()    # currently inside (confirmed, on-screen now)
        self._seen_ids:   set = set()    # every IDENTITY that has ever been granted an entry
        # Raw track_ids whose entry decision has already been finalised —
        # separate from _seen_ids (identities) because a track's identity
        # can take a few frames to resolve (FaceReId needs a minimum number
        # of observations before it will even attempt a match). Until a
        # track_id is in this set, it's still "pending": we know it's on
        # screen, but we deliberately have NOT yet counted an entry for it,
        # so its eventual resolution can never look like a departure+arrival.
        self._resolved_track_ids: set = set()
        # IDs the tracker still remembered as of the last frame (CONFIRMED
        # or LOST) — used to detect real departures rather than brief
        # occlusions. See `still_tracked_ids` in update(). Deliberately raw
        # track_ids, NEVER identity-mapped — see update() for why.
        self._tracked_ids: set = set()
        self._total_entries: int = 0
        self._total_exits:   int = 0
        self._peak:           int = 0
        self._session_start = time.time()
        logger.info("AttendanceCounter started | capacity=%d", venue_capacity)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(
        self,
        tracked_persons: list[TrackedPerson],
        still_tracked_ids: Optional[set[int]] = None,
        identity_map: Optional[dict] = None,
    ) -> None:
        """
        Update counts from the latest set of confirmed tracks.

        Args:
            tracked_persons: Output of ByteTracker.update() — confirmed tracks only.
                Used for current_attendance/peak and to detect new entries.
            still_tracked_ids: Optional — ByteTracker.active_track_ids (CONFIRMED
                + LOST). When provided, exits are only counted once a track
                actually drops out of the tracker's memory, not merely out of
                the confirmed list — so a brief occlusion during ByteTrack's
                own grace period (max_age) isn't miscounted as a departure.
                If omitted, falls back to the confirmed-only behaviour.
            identity_map: Optional — track_id -> stable identity string, from
                FaceReId.resolve(). When a person leaves and returns, the
                tracker assigns a new track_id, but face re-id maps it back
                to the SAME identity string as before — so a returning
                person isn't counted as a new entry. If omitted, track_id
                is used directly (today's behaviour, pre-face-reid).

                IMPORTANT: FaceReId doesn't resolve a track's identity on
                its very first frame — it needs a few observations first,
                and returns a transient placeholder (f"track:{track_id}")
                in the meantime. This method treats current_ids/exits by
                raw track_id, and only consults identity_map once per
                track_id (when its entry is finalised) purely to decide
                whether it's a *return* of someone already seen — never to
                re-derive current_attendance or exits. That's deliberate:
                if a still-on-screen track's mapped identity later changes
                (placeholder → resolved, or resolved → a different match),
                that must never look like the original identity "exiting"
                while a new one "enters" — it's the same physical person,
                the whole time, on screen the whole time.
        """
        identity_map = identity_map or {}
        current_track_ids = {p.track_id for p in tracked_persons}
        entries_before, exits_before = self._total_entries, self._total_exits

        # current_attendance / peak: always raw track_id based. These are
        # tracker-confirmed, on-screen-right-now people — identity is
        # irrelevant here and must never be allowed to perturb this count.
        self._active_ids = current_track_ids
        self._peak = max(self._peak, len(current_track_ids))

        # Entries: finalise (at most once per track_id) only once that
        # track's identity has actually resolved — i.e. is no longer the
        # FaceReId placeholder for a not-yet-matched track. A track still
        # pending resolution is skipped and retried next frame; it is
        # already counted in current_attendance above, it just hasn't had
        # an entry/return decision made for it yet.
        for tid in current_track_ids - self._resolved_track_ids:
            resolved = identity_map.get(tid, tid)
            if isinstance(resolved, str) and resolved == f"track:{tid}":
                continue  # FaceReId hasn't resolved this track yet — retry later
            self._resolved_track_ids.add(tid)
            if resolved not in self._seen_ids:
                self._seen_ids.add(resolved)
                self._total_entries += 1
            # else: resolved to an identity already credited with an entry
            # (a returning person under a new track_id) — no new entry.

        # Exits: raw track_id churn only, from the tracker's own "still
        # remembered" set (CONFIRMED+LOST) — never identity-mapped, so an
        # identity being refined for a still-tracked person can't look
        # like a departure.
        tracked_now = set(still_tracked_ids) if still_tracked_ids is not None else current_track_ids
        exited_ids = self._tracked_ids - tracked_now
        for tid in exited_ids:
            # A track that left before FaceReId ever resolved it (rare —
            # requires very few frames on screen) never got an entry
            # counted above. Credit it now, using the track_id itself as
            # a fallback identity, so genuinely brief visits aren't
            # silently dropped from total_entries.
            if tid not in self._resolved_track_ids:
                self._resolved_track_ids.add(tid)
                if tid not in self._seen_ids:
                    self._seen_ids.add(tid)
                    self._total_entries += 1
        self._total_exits += len(exited_ids)
        self._tracked_ids = tracked_now
        # Stop carrying resolution state for track_ids the tracker has
        # fully forgotten — keeps these sets bounded over a long session.
        self._resolved_track_ids &= tracked_now

        if self._total_entries != entries_before or self._total_exits != exits_before:
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
        self._resolved_track_ids.clear()
        self._tracked_ids.clear()
        self._total_entries = 0
        self._total_exits = 0
        self._peak = 0
        self._session_start = time.time()
        logger.info("AttendanceCounter reset")
