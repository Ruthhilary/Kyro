"""
Kyro — Movement Context Classifier

Answers the critical question: when track #42 leaves their seat,
WHERE did they go and WHY? This determines what happens to their seat.

Classification confidence levels:
- HIGH (≥0.8): Person is clearly inside an exclusion zone, or rota confirms it.
- MEDIUM (0.5–0.8): Moving toward stage area, or group surge detected.
- LOW (<0.5): Person absent, trajectory unclear → raises a ReviewRequest.

When confidence is LOW, the classifier does NOT guess — it raises a
ReviewRequest to the dashboard and holds the seat in its current state
until a human confirms. Auto-resolves to best_guess after 60 seconds.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np

from ai.tracking.bytetrack import TrackedPerson
from ai.seat_detection.review import ReviewQueue, ReviewRequest, ReviewAnswer
from ai.seat_detection.rota import RotaManager


class MovementType(str, Enum):
    SEATED           = "seated"
    ROTA             = "rota"
    STAGE_MOVE       = "stage_move"
    FRONT_RUSH       = "front_rush"
    ABSENCE          = "absence"
    EXIT             = "exit"
    REVIEW_PENDING   = "review_pending"   # Uncertain — waiting for human input


@dataclass
class ClassificationResult:
    movement: MovementType
    confidence: float
    review_request: Optional[ReviewRequest] = None  # Set when uncertain


@dataclass
class TrackHistory:
    track_id: int
    positions: deque = field(default_factory=lambda: deque(maxlen=60))
    last_seen: float = field(default_factory=time.monotonic)
    confirmed_seat_id: Optional[str] = None
    movement: MovementType = MovementType.ABSENCE
    # How long this track has been absent (for escalating absence questions)
    first_absent_time: Optional[float] = field(default=None, repr=False)
    # Front-of-venue presence — set when this person spends time at the front
    # before going absent. Used to raise altar_call_question instead of
    # the generic absence question.
    first_front_time:  Optional[float] = field(default=None, repr=False)
    last_front_time:   Optional[float] = field(default=None, repr=False)

    def add(self, cx: float, cy: float) -> None:
        self.positions.append((cx, cy, time.monotonic()))
        self.last_seen = time.monotonic()
        self.first_absent_time = None   # reset when seen

    def mark_absent(self) -> None:
        if self.first_absent_time is None:
            self.first_absent_time = time.monotonic()

    def mark_at_front(self) -> None:
        """Called each frame this person is classified as being at the front."""
        now = time.monotonic()
        if self.first_front_time is None:
            self.first_front_time = now
        self.last_front_time = now

    @property
    def seconds_at_front(self) -> float:
        """Total seconds this track was observed at the front of the venue."""
        if self.first_front_time is None or self.last_front_time is None:
            return 0.0
        return self.last_front_time - self.first_front_time

    @property
    def was_recently_at_front(self) -> bool:
        """True if the person was at the front and hasn't been seen since."""
        if self.last_front_time is None:
            return False
        # Only count as "recently at front" if their last known position was
        # the front — i.e. they didn't return to their seat first.
        return self.last_front_time >= (self.last_seen - 5.0)

    @property
    def seconds_absent(self) -> float:
        if self.first_absent_time is None:
            return 0.0
        return time.monotonic() - self.first_absent_time

    @property
    def velocity(self) -> tuple[float, float]:
        pts = list(self.positions)
        if len(pts) < 2:
            return 0.0, 0.0
        recent = pts[-min(10, len(pts)):]
        dx = recent[-1][0] - recent[0][0]
        dy = recent[-1][1] - recent[0][1]
        n  = len(recent) - 1
        return dx / n, dy / n

    @property
    def direction_unit(self) -> Optional[np.ndarray]:
        vx, vy = self.velocity
        mag = (vx ** 2 + vy ** 2) ** 0.5
        if mag < 2.0:
            return None
        return np.array([vx / mag, vy / mag])

    @property
    def current_pos(self) -> Optional[tuple[float, float]]:
        if not self.positions:
            return None
        p = self.positions[-1]
        return p[0], p[1]


class MovementClassifier:
    """
    Per-camera movement classifier with live human review integration.

    When confident → classifies immediately.
    When uncertain → raises a ReviewRequest to the dashboard and holds state.
    """

    FRONT_RUSH_COUNT      = 5
    FRONT_RUSH_SOFT_COUNT = 3    # Below this triggers a review question
    FRONT_RUSH_WINDOW_S   = 8.0
    STAGE_APPROACH_PX     = 80
    # Ask about absence after this many seconds of being invisible
    ABSENCE_REVIEW_S      = 120   # 2 minutes — standard
    # Urgent types fire sooner
    URGENT_REVIEW_S       = 60    # 1 minute for front-rush context
    # Minimum time at front before we consider asking altar call question (seconds)
    ALTAR_CALL_FRONT_S    = 120   # 2 minutes at front

    def __init__(
        self,
        stage_bboxes: list[np.ndarray],
        camera_id: str = "cam-01",
        frame_width: int  = 1280,
        frame_height: int = 720,
        exit_margin_px: int = 40,
        rota: Optional[RotaManager] = None,
    ) -> None:
        self._stage_bboxes = stage_bboxes
        self._camera_id    = camera_id
        self._frame_w      = frame_width
        self._frame_h      = frame_height
        self._exit_margin  = exit_margin_px
        self._rota         = rota or RotaManager()
        self._histories:   dict[int, TrackHistory] = {}
        self._recent_front_movers: deque = deque(maxlen=100)
        # Review queue — shared with the worker for Redis publishing
        self.review_queue  = ReviewQueue(camera_id)
        # Confirmed answers from the dashboard (track_id → MovementType)
        self._confirmed: dict[int, MovementType] = {}

    def apply_answer(self, review_id: str, answer_str: str) -> Optional[dict]:
        """
        Called when the dashboard sends a review answer.
        Returns updated classification for the affected track.
        """
        try:
            answer = ReviewAnswer(answer_str)
        except ValueError:
            return None

        req = self.review_queue.answer(review_id, answer)
        if not req:
            return None

        # Map answer → movement type
        mapping = {
            ReviewAnswer.YES:         MovementType.STAGE_MOVE,
            ReviewAnswer.STAGE:       MovementType.STAGE_MOVE,
            ReviewAnswer.NO:          MovementType.SEATED,
            ReviewAnswer.TOILET:      MovementType.ABSENCE,
            ReviewAnswer.LEFT:        MovementType.EXIT,
            ReviewAnswer.GAVE_LIFE:   MovementType.EXIT,     # responded at altar, now gone — seat is free
            ReviewAnswer.IGNORE:      MovementType.ABSENCE,
            ReviewAnswer.CREATE_ZONE: MovementType.STAGE_MOVE,
        }
        movement = mapping.get(answer, MovementType.ABSENCE)
        self._confirmed[req.track_id] = movement

        # Check if this creates enough evidence for a zone proposal
        proposals = self.review_queue.get_zone_proposals()

        return {
            "review_id":  review_id,
            "track_id":   req.track_id,
            "movement":   movement.value,
            "seat_id":    req.seat_id,
            "answer":     answer_str,
            "zone_proposals": proposals,
        }

    def update(
        self,
        tracked_persons: list[TrackedPerson],
        rota_held_ids: set[str],
        rota_held_rows: set[str],
    ) -> dict[int, MovementType]:
        """
        Update histories, classify each track, raise review requests for uncertain cases.
        Returns dict[track_id → MovementType].
        New ReviewRequests are accessible via self.review_queue.pending_requests().
        """
        now    = time.monotonic()
        active = {p.track_id for p in tracked_persons}

        # Expire old unanswered reviews (auto-resolve to best_guess)
        expired = self.review_queue.expire_old()
        for req in expired:
            if req.best_guess == "stage_move":
                self._confirmed[req.track_id] = MovementType.STAGE_MOVE
            elif req.best_guess == "gave_life":
                # No answer in time — hold the seat, don't auto-free it
                self._confirmed[req.track_id] = MovementType.ABSENCE
            elif req.best_guess == "absence":
                self._confirmed[req.track_id] = MovementType.ABSENCE

        # Update position histories
        for person in tracked_persons:
            cx = float((person.bbox[0] + person.bbox[2]) / 2)
            cy = float((person.bbox[1] + person.bbox[3]) / 2)
            if person.track_id not in self._histories:
                self._histories[person.track_id] = TrackHistory(track_id=person.track_id)
            self._histories[person.track_id].add(cx, cy)

        new_reviews: list[ReviewRequest] = []
        classifications: dict[int, MovementType] = {}
        front_movers_this_frame: list[int] = []

        # How many people have moved toward the front recently, BEFORE this
        # frame's classifications are added — lets us tell, ahead of time,
        # whether we're already in "several people moving to the front"
        # territory. Without this, the 1st/2nd/3rd person in a group front
        # movement (e.g. an altar call or communion) would each trigger
        # their OWN individual "is this the stage?" question, and THEN the
        # aggregate front-rush question fires too once the count crosses
        # FRONT_RUSH_SOFT_COUNT — asking about the same event 4 times over.
        _rush_cutoff = now - self.FRONT_RUSH_WINDOW_S
        _recent_count_so_far = len({tid for tid, t in self._recent_front_movers if t >= _rush_cutoff})
        _suppress_individual_stage_questions = _recent_count_so_far >= self.FRONT_RUSH_SOFT_COUNT

        # ── Classify active tracks ──────────────────────────────────────
        for person in tracked_persons:
            tid  = person.track_id
            hist = self._histories[tid]
            cx, cy = hist.current_pos or (0.0, 0.0)

            # Use confirmed answer if available
            if tid in self._confirmed:
                classifications[tid] = self._confirmed[tid]
                continue

            # Inside a known stage zone — high confidence
            if self._inside_stage(cx, cy):
                classifications[tid] = MovementType.STAGE_MOVE
                hist.mark_at_front()
                continue

            # Moving toward stage — medium confidence
            if self._moving_toward_stage(hist):
                if self._stage_bboxes:
                    # We have zones defined — confident, auto-classify
                    classifications[tid] = MovementType.STAGE_MOVE
                elif _suppress_individual_stage_questions:
                    # Several people are already moving to the front this
                    # window — let the ONE aggregate front-rush question
                    # (below) cover this, instead of also asking
                    # individually about this person.
                    classifications[tid] = MovementType.REVIEW_PENDING
                else:
                    # No zones defined yet, and not part of a group
                    # movement — genuinely uncertain, ask the user.
                    # Evidence uses the person's ACTUAL detected bbox
                    # (with padding) rather than a fixed-offset guess box,
                    # so the snapshot actually shows them, not empty
                    # background or an unrelated area.
                    px1, py1, px2, py2 = [float(v) for v in person.bbox]
                    pad_x = (px2 - px1) * 0.4
                    pad_y = (py2 - py1) * 0.4
                    req = self.review_queue.raise_stage_question(
                        track_id=tid,
                        seat_id=hist.confirmed_seat_id,
                        position=(cx, cy),
                        confidence=0.55,
                        suggested_bbox=[
                            max(0, px1 - pad_x), max(0, py1 - pad_y),
                            min(self._frame_w, px2 + pad_x), min(self._frame_h, py2 + pad_y),
                        ],
                    )
                    if req:
                        new_reviews.append(req)
                    classifications[tid] = MovementType.REVIEW_PENDING
                hist.mark_at_front()
                front_movers_this_frame.append(tid)
                continue

            # Near exit
            if self._near_exit(cx, cy):
                classifications[tid] = MovementType.EXIT
                continue

            # Moving toward front (not toward a known stage zone)
            direction = hist.direction_unit
            if direction is not None and direction[1] < -0.5:
                front_movers_this_frame.append(tid)

            classifications[tid] = MovementType.SEATED

        # ── Front rush detection ────────────────────────────────────────
        for tid in front_movers_this_frame:
            self._recent_front_movers.append((tid, now))

        cutoff     = now - self.FRONT_RUSH_WINDOW_S
        recent_ids = {tid for tid, t in self._recent_front_movers if t >= cutoff}
        count      = len(recent_ids)

        if count >= self.FRONT_RUSH_COUNT:
            # Confident rush
            for tid in recent_ids:
                if tid in classifications:
                    classifications[tid] = MovementType.FRONT_RUSH
        elif count >= self.FRONT_RUSH_SOFT_COUNT:
            # Soft rush — ask
            avg_pos = (self._frame_w / 2, self._frame_h * 0.2)
            req = self.review_queue.raise_front_rush_question(
                track_ids=list(recent_ids),
                count=count,
                position=avg_pos,
            )
            if req:
                new_reviews.append(req)

        # ── Absent tracks ───────────────────────────────────────────────
        for tid, hist in list(self._histories.items()):
            if tid not in active:
                hist.mark_absent()
                classifications[tid] = MovementType.ABSENCE

                # Escalate to review after 5 minutes absent
                if (hist.seconds_absent > self.ABSENCE_REVIEW_S
                        and hist.confirmed_seat_id
                        and tid not in self._confirmed):

                    # If this person was recently standing at the front for a
                    # sustained period, ask the specific altar call question
                    # instead of the generic absence one.
                    # The seat is held — nothing is freed until a human answers.
                    #
                    # ROTA CHECK: If the rota has an active window right now
                    # (choir, worship team, etc.), this person being at the front
                    # is EXPECTED — don't ask about altar call, it's scheduled.
                    rota_is_active = len(self._rota.active_entries) > 0
                    # Build evidence around the person's LAST known real
                    # position (before they went out of view), not the
                    # (0,0) placeholder this used to send — that produced
                    # a crop of the frame's top-left corner, unrelated to
                    # the actual seat/person ("rubbish evidence").
                    last_pos = hist.current_pos
                    last_bbox = None
                    if last_pos is not None:
                        lx, ly = last_pos
                        last_bbox = [
                            max(0, lx - 150), max(0, ly - 150),
                            min(self._frame_w, lx + 150), min(self._frame_h, ly + 150),
                        ]
                    if (hist.was_recently_at_front
                            and hist.seconds_at_front >= self.ALTAR_CALL_FRONT_S
                            and not rota_is_active):
                        req = self.review_queue.raise_altar_call_question(
                            track_id=tid,
                            seat_id=hist.confirmed_seat_id,
                            seconds_at_front=hist.seconds_at_front,
                            absent_seconds=hist.seconds_absent,
                            last_position=last_pos,
                            suggested_bbox=last_bbox,
                        )
                    else:
                        # Either on rota schedule, or didn't spend enough time
                        # at the front — treat as a generic absence
                        req = self.review_queue.raise_absence_question(
                            track_id=tid,
                            seat_id=hist.confirmed_seat_id,
                            absent_seconds=hist.seconds_absent,
                            last_position=last_pos,
                            suggested_bbox=last_bbox,
                        )
                    if req:
                        new_reviews.append(req)

                # Clean up very stale
                if hist.seconds_absent > 600:
                    del self._histories[tid]
                    self._confirmed.pop(tid, None)

        # Store new review requests for the worker to publish
        self._new_reviews = new_reviews
        return classifications

    @property
    def new_review_requests(self) -> list[ReviewRequest]:
        """Drain and return review requests raised this frame."""
        reqs = getattr(self, "_new_reviews", [])
        self._new_reviews = []
        return reqs

    def update_stage_zones(self, bboxes: list[np.ndarray]) -> None:
        self._stage_bboxes = bboxes

    def record_seat_for_track(self, track_id: int, seat_id: str) -> None:
        """Called by occupancy engine when a track is confirmed in a seat."""
        if track_id in self._histories:
            self._histories[track_id].confirmed_seat_id = seat_id

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _inside_stage(self, cx: float, cy: float) -> bool:
        for bbox in self._stage_bboxes:
            if bbox[0] <= cx <= bbox[2] and bbox[1] <= cy <= bbox[3]:
                return True
        return False

    def _moving_toward_stage(self, hist: TrackHistory) -> bool:
        direction = hist.direction_unit
        if direction is None:
            return False
        cx, cy = hist.current_pos or (0.0, 0.0)
        projected_x = cx + direction[0] * self.STAGE_APPROACH_PX
        projected_y = cy + direction[1] * self.STAGE_APPROACH_PX
        return self._inside_stage(projected_x, projected_y) or (
            direction[1] < -0.6 and cy < self._frame_h * 0.35
        )

    def _near_exit(self, cx: float, cy: float) -> bool:
        m = self._exit_margin
        return (
            cx < m or cx > self._frame_w - m or
            cy < m or cy > self._frame_h - m
        )
