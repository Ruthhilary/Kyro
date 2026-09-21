"""
Kyro — Live Review Queue with Persistent Spatial Memory

When the MovementClassifier is uncertain, it raises a ReviewRequest.
Admin answers are stored permanently in the DB via Redis.

Memory system:
- Confirmed answers are quantised to a spatial grid (64px cells).
- Each cell stores a classification + confirmation count.
- At ZONE_THRESHOLD confirmations the region auto-becomes an exclusion zone.
- Memory is loaded at worker startup — the system NEVER asks about a
  region it has already learned.

This means after 3 "Yes, it's the stage" answers for the front area,
the question is gone forever for that camera. Next service, next year —
it already knows.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ReviewType(str, Enum):
    STAGE_QUESTION      = "stage_question"
    FRONT_RUSH_QUESTION = "front_rush_question"
    ABSENCE_QUESTION    = "absence_question"
    ZONE_PROPOSAL       = "zone_proposal"
    ALTAR_CALL_QUESTION = "altar_call_question"   # person was at front, then left building

# Maps each review type to the role that should see it
REVIEW_TARGET_ROLE: dict[str, str] = {
    "stage_question":      "admin",       # spatial — trains the building layout
    "zone_proposal":       "admin",       # spatial
    "front_rush_question": "operator",    # people-level — usher knows what happened
    "absence_question":    "operator",    # people-level — usher is on the floor
    "altar_call_question": "operator",    # usher at front would know if they responded
}


class ReviewAnswer(str, Enum):
    YES          = "yes"
    NO           = "no"
    TOILET       = "toilet"
    LEFT         = "left"
    STAGE        = "stage"
    IGNORE       = "ignore"
    CREATE_ZONE  = "create_zone"
    GAVE_LIFE    = "gave_life"     # person gave their life to Christ at the altar


@dataclass
class LearnedRegion:
    """One spatially-quantised learned classification."""
    region_key:         str
    cx:                 float
    cy:                 float
    classification:     str    # "stage_move" | "exit" | "absence"
    confirmation_count: int
    auto_zone_created:  bool = False

    @property
    def bbox(self) -> list[float]:
        """Approximate bbox around this grid cell (for zone creation)."""
        half = 96  # ~1.5 grid cells
        return [self.cx - half, self.cy - half, self.cx + half, self.cy + half]


@dataclass
class ReviewRequest:
    review_id:   str
    camera_id:   str
    review_type: ReviewType
    question:    str
    track_id:    int
    seat_id:     Optional[str]
    position:    tuple[float, float]
    bbox_hint:   Optional[list[float]] = None
    confidence:  float = 0.0
    best_guess:  Optional[str] = None
    options:     list[str] = field(default_factory=list)
    created_at:  float = field(default_factory=time.time)
    answered:    bool = False
    answer:      Optional[ReviewAnswer] = None

    def to_dict(self) -> dict:
        return {
            "type":        "review_request",
            "review_id":   self.review_id,
            "camera_id":   self.camera_id,
            "review_type": self.review_type.value,
            # Who should see this question
            "target_role": REVIEW_TARGET_ROLE.get(self.review_type.value, "operator"),
            "question":    self.question,
            "track_id":    self.track_id,
            "seat_id":     self.seat_id,
            "position":    list(self.position),
            "bbox_hint":   self.bbox_hint,
            "confidence":  round(self.confidence, 2),
            "best_guess":  self.best_guess,
            "options":     self.options,
            "created_at":  self.created_at,
        }


class ReviewQueue:
    """
    Manages pending review requests for one camera.

    Spatial memory is pre-loaded from the DB so known regions
    never trigger questions again. New confirmed answers are published
    to Redis for the backend to persist.
    """

    COOLDOWN_S       = 120.0  # Don't re-ask about same track within 2 min (was 30s)
    EXPIRE_S         = 90.0   # Auto-resolve after 90s (was 60s)
    ZONE_THRESHOLD   = 3      # Confirmations before auto-creating a zone
    GRID             = 64     # Spatial quantisation cell size (pixels)

    def __init__(self, camera_id: str) -> None:
        self.camera_id = camera_id
        self._pending:  dict[str, ReviewRequest] = {}
        self._asked:    dict[int, float] = {}
        self._ignored:  set[int] = set()

        # Persistent spatial memory: region_key → LearnedRegion
        # Loaded from DB on startup via load_memory()
        self._memory: dict[str, LearnedRegion] = {}

        # Regions where we know what classification to use — skip asking
        self._known_stage_regions:  set[str] = set()
        self._known_exit_regions:   set[str] = set()

        # Newly confirmed answers pending DB persistence (read by worker)
        self._pending_persist: list[dict] = []

    # ------------------------------------------------------------------
    # Memory management
    # ------------------------------------------------------------------

    def load_memory(self, learned_regions: list[dict]) -> None:
        """
        Called at worker startup with records from the DB.
        learned_regions: list of dicts with keys:
            region_key, cx, cy, classification, confirmation_count, auto_zone_created
        """
        for r in learned_regions:
            key = r["region_key"]
            region = LearnedRegion(
                region_key=key,
                cx=r["cx"],
                cy=r["cy"],
                classification=r["classification"],
                confirmation_count=r["confirmation_count"],
                auto_zone_created=r.get("auto_zone_created", False),
            )
            self._memory[key] = region
            if region.classification == "stage_move":
                self._known_stage_regions.add(key)
            elif region.classification == "exit":
                self._known_exit_regions.add(key)

    def is_known_stage(self, cx: float, cy: float) -> bool:
        """True if this position is in a learned stage region."""
        key = self._region_key((cx, cy))
        return key in self._known_stage_regions

    def is_known_exit(self, cx: float, cy: float) -> bool:
        key = self._region_key((cx, cy))
        return key in self._known_exit_regions

    def drain_persist_queue(self) -> list[dict]:
        """Return and clear pending DB persistence items."""
        items = list(self._pending_persist)
        self._pending_persist.clear()
        return items

    # ------------------------------------------------------------------
    # Question gating
    # ------------------------------------------------------------------

    def should_ask(self, track_id: int, position: Optional[tuple[float, float]] = None) -> bool:
        """
        True if we should raise a review question for this track/position.
        Returns False if:
        - Already asked recently (cooldown)
        - User told us to ignore this track
        - The position is in a learned/known region (memory hit)
        """
        if track_id in self._ignored:
            return False
        last = self._asked.get(track_id, 0)
        if (time.monotonic() - last) <= self.COOLDOWN_S:
            return False
        # Memory check — if we know this region, no need to ask
        if position is not None:
            key = self._region_key(position)
            if key in self._memory:
                return False
        return True

    # ------------------------------------------------------------------
    # Raise questions
    # ------------------------------------------------------------------

    def raise_stage_question(
        self,
        track_id: int,
        seat_id: Optional[str],
        position: tuple[float, float],
        confidence: float,
        suggested_bbox: Optional[list[float]] = None,
        zone_name: str = "",
    ) -> Optional[ReviewRequest]:
        if not self.should_ask(track_id, position):
            return None
        seat_ref = f"Seat {seat_id}" if seat_id else "Someone"
        zone_ref = f" ({zone_name})" if zone_name else ""
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.STAGE_QUESTION,
            question=f"{seat_ref}{zone_ref} moved toward the front — is this the stage or altar area?",
            track_id=track_id,
            seat_id=seat_id,
            position=position,
            bbox_hint=suggested_bbox,
            confidence=confidence,
            best_guess="stage_move",
            options=["Yes, it's the stage/altar", "No — toilet break", "No — they left the building", "Ignore this"],
        )
        self._pending[req.review_id] = req
        self._asked[track_id] = time.monotonic()
        return req

    def raise_long_vacancy_question(
        self,
        track_id: int,
        seat_id: str,
        row: str,
        section: str,
        vacant_seconds: float,
    ) -> Optional[ReviewRequest]:
        """Seat has been vacant for a long time — ask if it's genuinely free."""
        if not self.should_ask(track_id):
            return None
        mins = int(vacant_seconds / 60)
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.ABSENCE_QUESTION,
            question=f"Seat {seat_id} (Row {row}, {section}) has been empty for {mins} min — is it free now?",
            track_id=track_id,
            seat_id=seat_id,
            position=(0.0, 0.0),
            confidence=0.45,
            best_guess="absence",
            options=["Yes — free the seat", "No — they're coming back", "They went on stage", "Left the building"],
        )
        self._pending[req.review_id] = req
        self._asked[track_id] = time.monotonic()
        return req

    def raise_reentry_question(
        self,
        track_id: int,
        seat_id: str,
        section: str,
        away_seconds: float,
    ) -> Optional[ReviewRequest]:
        """Person returned to a seat after being away — confirm it's the right person."""
        if not self.should_ask(track_id):
            return None
        mins = int(away_seconds / 60)
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.ABSENCE_QUESTION,
            question=f"Someone returned to Seat {seat_id} ({section}) after {mins} min away — is this the original occupant?",
            track_id=track_id,
            seat_id=seat_id,
            position=(0.0, 0.0),
            confidence=0.6,
            best_guess="seated",
            options=["Yes — same person back", "No — different person", "Not sure (keep as occupied)", "Ignore"],
        )
        self._pending[req.review_id] = req
        self._asked[track_id] = time.monotonic()
        return req

    def raise_capacity_warning(
        self,
        section: str,
        current: int,
        capacity: int,
    ) -> Optional[ReviewRequest]:
        """Section is near capacity — confirm head count is accurate."""
        synthetic_id = -1 * (hash(section) % 100000)
        if not self.should_ask(synthetic_id):
            return None
        pct = int((current / capacity) * 100) if capacity > 0 else 0
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.ZONE_PROPOSAL,
            question=f"{section} is at {pct}% capacity ({current}/{capacity}) — does this match what you see on the floor?",
            track_id=synthetic_id,
            seat_id=None,
            position=(0.0, 0.0),
            confidence=0.7,
            best_guess="seated",
            options=["Yes — count looks right", "No — higher than shown", "No — lower than shown", "Ignore"],
        )
        self._pending[req.review_id] = req
        self._asked[synthetic_id] = time.monotonic()
        return req

    def raise_standing_group_question(
        self,
        track_ids: list[int],
        count: int,
        section: str,
        position: tuple[float, float],
    ) -> Optional[ReviewRequest]:
        """Group of people standing — are they about to sit or leaving?"""
        key = self._region_key(position)
        if key in self._memory:
            return None
        synthetic_id = -2 * (count * 777 + int(time.time()) % 999)
        if not self.should_ask(synthetic_id, position):
            return None
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.FRONT_RUSH_QUESTION,
            question=f"{count} people standing in {section} — are they looking for seats, leaving, or is this a worship moment?",
            track_id=synthetic_id,
            seat_id=None,
            position=position,
            confidence=0.45,
            best_guess="seated",
            options=["Finding seats — hold", "Worship / standing prayer", "Leaving the section", "Ignore"],
        )
        self._pending[req.review_id] = req
        self._asked[synthetic_id] = time.monotonic()
        return req

    def raise_front_rush_question(
        self,
        track_ids: list[int],
        count: int,
        position: tuple[float, float],
        section: str = "",
    ) -> Optional[ReviewRequest]:
        key = self._region_key(position)
        if key in self._memory:
            return None
        synthetic_id = -1 * (count * 1000 + int(time.time()) % 1000)
        if not self.should_ask(synthetic_id, position):
            return None
        section_ref = f" from {section}" if section else ""
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.FRONT_RUSH_QUESTION,
            question=f"{count} people{section_ref} moved toward the front — did someone go to the altar or stage?",
            track_id=synthetic_id,
            seat_id=None,
            position=position,
            confidence=0.55,
            best_guess="front_rush",
            options=["Yes, altar/stage call", "No, just coincidence", "Pastor arrived at front", "Ignore"],
        )
        self._pending[req.review_id] = req
        self._asked[synthetic_id] = time.monotonic()
        return req

    def raise_absence_question(
        self,
        track_id: int,
        seat_id: Optional[str],
        absent_seconds: float,
        last_position: Optional[tuple[float, float]] = None,
        suggested_bbox: Optional[list[float]] = None,
    ) -> Optional[ReviewRequest]:
        if not self.should_ask(track_id):
            return None
        mins = int(absent_seconds / 60)
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.ABSENCE_QUESTION,
            question=f"Seat {seat_id or '?'} has been empty for {mins} min — where did they go?",
            track_id=track_id,
            seat_id=seat_id,
            # Last real position before they went out of view — showing
            # the top-left frame corner (the old (0.0, 0.0) placeholder)
            # when we actually have a last-known location was exactly the
            # "rubbish evidence" this fixes.
            position=last_position or (0.0, 0.0),
            bbox_hint=suggested_bbox,
            confidence=0.4,
            best_guess="absence",
            options=["Toilet / short break", "Went on stage", "Left the building", "Still in seat (ignore)"],
        )
        self._pending[req.review_id] = req
        self._asked[track_id] = time.monotonic()
        return req

    def raise_altar_call_question(
        self,
        track_id: int,
        seat_id: Optional[str],
        seconds_at_front: float,
        absent_seconds: float,
        last_position: Optional[tuple[float, float]] = None,
        suggested_bbox: Optional[list[float]] = None,
    ) -> Optional[ReviewRequest]:
        """
        Raised when a person was standing at the front for a sustained period
        and has since left the building or gone invisible.

        This is different from a generic absence — the system observed
        specific front-of-venue behaviour before the person disappeared,
        so we ask the usher whether this was an altar response.

        The seat is NOT freed until a human answers — evidence first.
        """
        if not self.should_ask(track_id):
            return None
        front_mins   = int(seconds_at_front / 60)
        absent_mins  = int(absent_seconds / 60)
        req = ReviewRequest(
            review_id=str(uuid.uuid4())[:8],
            camera_id=self.camera_id,
            review_type=ReviewType.ALTAR_CALL_QUESTION,
            question=(
                f"Seat {seat_id or '?'}: person was at the front for ~{front_mins} min, "
                f"then left {absent_mins} min ago — did they give their life to Christ?"
            ),
            track_id=track_id,
            seat_id=seat_id,
            position=last_position or (0.0, 0.0),
            bbox_hint=suggested_bbox,
            confidence=0.5,
            best_guess="gave_life",
            options=[
                "Yes — gave their life to Christ ✝",
                "No — went to the toilet",
                "No — left the building",
                "Still here (ignore)",
            ],
        )
        self._pending[req.review_id] = req
        self._asked[track_id] = time.monotonic()
        return req

    # ------------------------------------------------------------------
    # Answer handling
    # ------------------------------------------------------------------

    def answer(self, review_id: str, answer: ReviewAnswer) -> Optional[ReviewRequest]:
        """
        Record a human answer. Updates in-memory learning and queues
        DB persistence.
        """
        req = self._pending.get(review_id)
        if not req:
            return None

        req.answered = True
        req.answer = answer
        del self._pending[review_id]

        if answer == ReviewAnswer.IGNORE:
            self._ignored.add(req.track_id)
            return req

        # Map answer to a classification string
        classification = {
            ReviewAnswer.YES:        "stage_move",
            ReviewAnswer.STAGE:      "stage_move",
            ReviewAnswer.NO:         "seated",
            ReviewAnswer.TOILET:     "absence",
            ReviewAnswer.LEFT:       "exit",
            ReviewAnswer.GAVE_LIFE:  "exit",      # they responded and left — seat is free
            ReviewAnswer.CREATE_ZONE: "stage_move",
        }.get(answer, "absence")

        # Skip spatial learning for absence-type answers (no fixed position)
        if req.position == (0.0, 0.0):
            return req

        # Update in-memory spatial learning
        key = self._region_key(req.position)
        existing = self._memory.get(key)
        if existing and existing.classification == classification:
            existing.confirmation_count += 1
        else:
            existing = LearnedRegion(
                region_key=key,
                cx=req.position[0],
                cy=req.position[1],
                classification=classification,
                confirmation_count=1,
            )
            self._memory[key] = existing

        # Update known-region sets
        if classification == "stage_move":
            self._known_stage_regions.add(key)
        elif classification == "exit":
            self._known_exit_regions.add(key)

        # Queue for DB persistence
        zone_created = (
            existing.confirmation_count >= self.ZONE_THRESHOLD
            and not existing.auto_zone_created
            and classification == "stage_move"
        )
        if zone_created:
            existing.auto_zone_created = True

        self._pending_persist.append({
            "camera_id":          self.camera_id,
            "region_key":         key,
            "cx":                 req.position[0],
            "cy":                 req.position[1],
            "classification":     classification,
            "confirmation_count": existing.confirmation_count,
            "auto_zone_created":  existing.auto_zone_created,
            "create_zone":        zone_created,
            "suggested_bbox":     req.bbox_hint or existing.bbox,
        })

        return req

    # ------------------------------------------------------------------
    # Expiry and proposals
    # ------------------------------------------------------------------

    def expire_old(self) -> list[ReviewRequest]:
        now = time.time()
        expired = [r for r in self._pending.values() if (now - r.created_at) > self.EXPIRE_S]
        for req in expired:
            req.answered = True
            req.answer = None
            del self._pending[req.review_id]
        return expired

    def get_zone_proposals(self) -> list[LearnedRegion]:
        """Regions that have reached the threshold and need a zone created."""
        return [
            r for r in self._memory.values()
            if r.classification == "stage_move"
            and r.confirmation_count >= self.ZONE_THRESHOLD
            and not r.auto_zone_created
        ]

    def pending_requests(self) -> list[dict]:
        return [r.to_dict() for r in self._pending.values() if not r.answered]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _region_key(self, pos: tuple[float, float]) -> str:
        return f"{int(pos[0] / self.GRID)}:{int(pos[1] / self.GRID)}"
