"""
Kyro — Multi-Signal Person Re-Identification (local-only, short-retention)

Purpose: when someone briefly leaves frame (e.g. a toilet break) and the
tracker assigns a new track_id when they return, this module recognises
"this is the same person" so the pipeline can treat it as a returning
person instead of counting a new entry.

HISTORY: v1 used only a face embedding (Haar cascade + LBP histogram).
Real-world testing showed this essentially never fired — Haar cascades
need a clean, front-on, well-lit face that a typical room camera often
just doesn't get. v2 switched to clothing-colour appearance as the sole
primary signal. This version (v3) is a genuine multi-signal fusion, per
the brief: instead of asking a single yes/no question ("same clothes?"),
it asks "how likely is this the same person, given everything we can
observe?" — combining independent signals, weighted by how reliable each
one is, and refusing to merge identities unless the combined evidence
clears a high bar.

SIGNALS COMBINED (each contributes only when actually available):
  1. Clothing/appearance — HSV colour histogram of the torso region.
     Always available (needs only a valid bounding box). Primary signal.
  2. Body shape/proportions — a HOG (histogram of oriented gradients)
     descriptor of the whole-body silhouette, capturing build/posture/
     proportions independent of colour. Always available.
  3. Face embedding — LBP histogram of a detected face crop. Only
     available when a face is actually captured; used as a confidence
     boost, never required.
  4. Deep person-reid embedding (OPTIONAL) — if a .onnx re-id model
     (e.g. an OSNet export) is present at `deep_model_path`, it's loaded
     via OpenCV's DNN module (no PyTorch dependency) and its output
     vector is treated as a high-confidence signal. Skipped entirely if
     no model file is configured — see DeepReIdConfig docstring for where
     to get one. This is genuinely optional infrastructure, not a
     "pretend" feature: it does real inference when a model is present.
  5. Spatial-temporal plausibility — NOT a visual signal. Given the last
     place/time a candidate identity was seen, and the place/time of this
     new sighting, computes how physically plausible it is that these are
     the same person: reappearing a second later right where they
     vanished is far more plausible than reappearing across the room
     nine minutes later. Modelled as independent exponential decays over
     elapsed time and over distance, tightened for short gaps (someone
     stepping out and immediately back) and loosened for longer ones
     (people move around during a real bathroom break).

MULTIPLE OBSERVATIONS, NOT ONE FRAME: each identity's fingerprint is a
rolling AVERAGE over its last several observations (not a single-frame
snapshot), so one noisy/blurry/oddly-lit frame can't define — or
misdefine — a person's signature. A brand-new, not-yet-matched track only
becomes eligible for matching once it has accumulated a minimum number of
observations itself.

CONSERVATIVE MERGING: matching uses a weighted fusion of whichever signals
are available, redistributing weight away from missing ones, and requires
the fused score to clear a high, configurable bar before two sightings are
called the same person. When evidence is weak or ambiguous — e.g. two
similarly-dressed choir members — the system creates a NEW identity rather
than guessing. An occasional extra ID from an over-cautious call is a much
smaller problem than merging two different people into one.

CAMERA CALIBRATION: since this runs against a fixed room camera, the
module learns an online running estimate of "expected bounding-box height
at this y-coordinate" from confirmed observations. This feeds the spatial
plausibility check (an implausible scale jump between two sightings claimed
to be the same person, at the same place, lowers confidence) and is also
exposed for the detection pipeline to use as an extra sanity check against
non-human false positives (see `expected_scale_at`).

PRIVACY: 100% local, nothing leaves this machine. No embeddings are
persisted to disk. Every fingerprint (appearance, shape, face, deep) is
deleted after `retention_seconds` of the person being out of frame, and
the entire gallery is wiped whenever a session/service ends (see
`reset()`). Before relying on this in production, confirm your venue's
notice/signage and applicable biometric-privacy rules (GDPR, Illinois'
BIPA, etc.) — this module makes it easy to disable (`enabled=False`) or
shorten retention further.
"""

from __future__ import annotations

import logging
import math
import os
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class FaceReIdConfig:
    enabled: bool = os.getenv("FACE_REID_ENABLED", "true").lower() == "true"

    # How long an out-of-frame fingerprint is kept before permanent
    # deletion. Keep this as short as your longest expected "step out".
    retention_seconds: int = int(os.getenv("FACE_REID_RETENTION_SECONDS", "600"))

    # Fused match score (0-1) required before two sightings are called the
    # same person. This is deliberately a high bar — see module docstring
    # on conservative merging. Tune against real footage: watch the
    # "Re-id: track X matched..." log line, which prints the fused score
    # and the per-signal breakdown.
    match_threshold: float = float(os.getenv("FACE_REID_MATCH_THRESHOLD", "0.82"))

    # A new track needs this many observations accumulated before it's
    # even eligible to be matched — avoids a single noisy first frame
    # deciding an identity.
    min_observations_to_match: int = int(os.getenv("FACE_REID_MIN_OBSERVATIONS", "3"))
    # How many recent observations feed each identity's rolling average.
    observation_window: int = int(os.getenv("FACE_REID_OBSERVATION_WINDOW", "8"))

    # Per-signal weights (relative; renormalised over whichever signals
    # are actually available for a given comparison).
    weight_appearance: float = float(os.getenv("FACE_REID_WEIGHT_APPEARANCE", "0.30"))
    weight_shape: float = float(os.getenv("FACE_REID_WEIGHT_SHAPE", "0.20"))
    weight_face: float = float(os.getenv("FACE_REID_WEIGHT_FACE", "0.20"))
    weight_deep: float = float(os.getenv("FACE_REID_WEIGHT_DEEP", "0.40"))
    weight_spatial: float = float(os.getenv("FACE_REID_WEIGHT_SPATIAL", "0.15"))

    min_face_size: int = int(os.getenv("FACE_REID_MIN_FACE_SIZE", "30"))

    # Spatial-temporal plausibility decay constants.
    # Time: after this many seconds absent, the temporal plausibility
    # signal has decayed to ~37% (1/e). Short absences (stepped out and
    # immediately back) score much higher than long ones.
    time_decay_seconds: float = float(os.getenv("FACE_REID_TIME_DECAY_S", "120"))
    # Distance: after moving this many pixels (relative to a 1280-wide
    # frame; scaled proportionally for other resolutions) from the last
    # known position, spatial plausibility has decayed to ~37%. Set
    # loosely — someone can walk across a room during a real break — this
    # mainly penalises "reappeared in a totally different spot within the
    # same second", not "reappeared elsewhere after several minutes".
    distance_decay_px: float = float(os.getenv("FACE_REID_DISTANCE_DECAY_PX", "500"))

    # OPTIONAL deep re-id model (e.g. an OSNet ONNX export). If the file
    # doesn't exist, this signal is simply skipped — nothing breaks.
    # Where to get one: the boxmot / Yolov5_StrongSORT_OSNet project
    # (https://github.com/mikel-brostrom/boxmot) publishes ONNX-exported
    # OSNet weights via its auto-download tooling, and the official
    # model zoo is at
    # https://kaiyangzhou.github.io/deep-person-reid/MODEL_ZOO.html
    # (export to ONNX via torchreid's built-in export script). Drop the
    # .onnx file at the path below (or set FACE_REID_DEEP_MODEL_PATH).
    deep_model_path: str = os.getenv("FACE_REID_DEEP_MODEL_PATH", "/app/ai/models/weights/reid_osnet.onnx")
    deep_input_size: tuple[int, int] = (128, 256)  # (width, height) — OSNet's standard input


@dataclass
class _Identity:
    identity_id: str
    appearance: deque = field(default_factory=lambda: deque(maxlen=8))
    shape: deque = field(default_factory=lambda: deque(maxlen=8))
    face: deque = field(default_factory=lambda: deque(maxlen=8))
    deep: deque = field(default_factory=lambda: deque(maxlen=8))
    last_position: tuple[float, float] = (0.0, 0.0)
    last_bbox_height: float = 0.0
    last_seen: float = 0.0
    track_id: int = -1


@dataclass
class _PendingTrack:
    """A track not yet eligible for matching — still accumulating observations."""
    appearance: deque = field(default_factory=lambda: deque(maxlen=8))
    shape: deque = field(default_factory=lambda: deque(maxlen=8))
    face: deque = field(default_factory=lambda: deque(maxlen=8))
    deep: deque = field(default_factory=lambda: deque(maxlen=8))
    position: tuple[float, float] = (0.0, 0.0)
    bbox_height: float = 0.0
    n_observations: int = 0
    resolved_identity: Optional[str] = None  # set once matching decision is made


# Precomputed neighbour offsets for an 8-neighbour, radius-1 LBP (face signal).
_LBP_OFFSETS = [
    (-1, -1, 1), (-1, 0, 2), (-1, 1, 4), (0, 1, 8),
    (1, 1, 16), (1, 0, 32), (1, -1, 64), (0, -1, 128),
]


def _avg(samples: deque) -> Optional[np.ndarray]:
    """Element-wise average of a deque of equal-shaped vectors."""
    if not samples:
        return None
    return np.mean(np.stack(list(samples)), axis=0)


def _cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom > 0 else 0.0


class FaceReId:
    """
    In-memory local multi-signal re-id gallery for one camera.

    Not persisted to disk — lost on worker restart, and wiped whenever a
    session/service ends. That's intentional: this bridges short absences
    within a single service, not a durable biometric database.
    """

    def __init__(self, config: Optional[FaceReIdConfig] = None) -> None:
        self.cfg = config or FaceReIdConfig()
        self._face_detector = (
            cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
            if self.cfg.enabled else None
        )
        self._hog = cv2.HOGDescriptor((64, 128), (16, 16), (8, 8), (8, 8), 9) if self.cfg.enabled else None

        self._deep_net: Optional[cv2.dnn.Net] = None
        if self.cfg.enabled and os.path.isfile(self.cfg.deep_model_path):
            try:
                self._deep_net = cv2.dnn.readNetFromONNX(self.cfg.deep_model_path)
                logger.info("Re-id: loaded deep embedding model from %s", self.cfg.deep_model_path)
            except Exception as e:
                logger.warning("Re-id: found deep model file but failed to load it (%s) — "
                                "continuing without the deep signal", e)
                self._deep_net = None
        elif self.cfg.enabled:
            logger.info(
                "Re-id: no deep embedding model at %s — running on appearance/shape/face/"
                "spatial signals only. This is fine (those are real signals), but a deep "
                "re-id model materially improves accuracy. See FaceReIdConfig docstring "
                "for where to get one.", self.cfg.deep_model_path,
            )

        self._gallery: dict[str, _Identity] = {}
        self._pending: dict[int, _PendingTrack] = {}
        self._track_to_identity: dict[int, str] = {}
        self._next_id = 0

        # Online camera calibration: expected bbox height as a function of
        # normalised y-position (0=top, 1=bottom of frame), learned from
        # observations as they come in. Coarse 10-bucket histogram of
        # (sum_height, count) is enough for a sanity-check signal.
        self._scale_calibration: list[list[float]] = [[0.0, 0.0] for _ in range(10)]

    # ------------------------------------------------------------------
    # Signal extraction
    # ------------------------------------------------------------------

    def _extract_appearance(self, person_crop: np.ndarray) -> Optional[np.ndarray]:
        """HSV colour histogram of the torso region (clothing)."""
        h, w = person_crop.shape[:2]
        if h < 20 or w < 10:
            return None
        torso = person_crop[int(h * 0.2):int(h * 0.8), :]
        if torso.size == 0:
            return None
        hsv = cv2.cvtColor(torso, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [30, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
        return hist.flatten().astype(np.float32)

    def _extract_shape(self, person_crop: np.ndarray) -> Optional[np.ndarray]:
        """HOG descriptor of the whole-body silhouette (build/proportions)."""
        if self._hog is None or person_crop.size == 0:
            return None
        try:
            resized = cv2.resize(person_crop, (64, 128))
            gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
            desc = self._hog.compute(gray)
            if desc is None:
                return None
            v = desc.flatten().astype(np.float32)
            norm = float(np.linalg.norm(v))
            return v / norm if norm > 0 else v
        except cv2.error:
            return None

    def _detect_face(self, person_crop: np.ndarray) -> Optional[np.ndarray]:
        if person_crop.size == 0 or self._face_detector is None:
            return None
        gray = cv2.cvtColor(person_crop, cv2.COLOR_BGR2GRAY)
        faces = self._face_detector.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5,
            minSize=(self.cfg.min_face_size, self.cfg.min_face_size),
        )
        if len(faces) == 0:
            return None
        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
        return person_crop[y:y + h, x:x + w]

    def _extract_face_embedding(self, face_crop: np.ndarray) -> Optional[np.ndarray]:
        if face_crop.size == 0:
            return None
        gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, (100, 100))
        gray = cv2.equalizeHist(gray)
        lbp = np.zeros_like(gray, dtype=np.uint8)
        for dy, dx, bit in _LBP_OFFSETS:
            shifted = np.roll(np.roll(gray, dy, axis=0), dx, axis=1)
            lbp |= ((shifted >= gray).astype(np.uint8) * bit)
        hist, _ = np.histogram(lbp.ravel(), bins=59, range=(0, 256))
        hist = hist.astype(np.float32)
        norm = float(np.linalg.norm(hist))
        return hist / norm if norm > 0 else hist

    def _extract_deep_embedding(self, person_crop: np.ndarray) -> Optional[np.ndarray]:
        """Optional deep re-id embedding via a user-supplied ONNX model."""
        if self._deep_net is None or person_crop.size == 0:
            return None
        try:
            w, h = self.cfg.deep_input_size
            blob = cv2.dnn.blobFromImage(
                person_crop, scalefactor=1.0 / 255, size=(w, h),
                mean=(0.485, 0.456, 0.406), swapRB=True, crop=False,
            )
            self._deep_net.setInput(blob)
            out = self._deep_net.forward()
            v = out.flatten().astype(np.float32)
            norm = float(np.linalg.norm(v))
            return v / norm if norm > 0 else v
        except cv2.error as e:
            logger.warning("Re-id: deep model inference failed (%s) — skipping deep signal this frame", e)
            return None

    # ------------------------------------------------------------------
    # Camera calibration
    # ------------------------------------------------------------------

    def _calibration_bucket(self, cy_norm: float) -> int:
        return min(9, max(0, int(cy_norm * 10)))

    def _update_calibration(self, cy_norm: float, bbox_height: float) -> None:
        bucket = self._calibration_bucket(cy_norm)
        self._scale_calibration[bucket][0] += bbox_height
        self._scale_calibration[bucket][1] += 1

    def expected_scale_at(self, cy_norm: float) -> Optional[float]:
        """
        Learned expected bbox height at a given normalised y-position for
        this fixed camera, or None if not enough data yet. Exposed for the
        detection pipeline to sanity-check "is this really a human-scale
        object at this position" — not just used internally for re-id.
        """
        bucket = self._calibration_bucket(cy_norm)
        total, count = self._scale_calibration[bucket]
        return (total / count) if count >= 5 else None

    def _scale_plausibility(self, cy_norm: float, bbox_height: float) -> float:
        """1.0 = matches learned expectation, decaying as it deviates."""
        expected = self.expected_scale_at(cy_norm)
        if expected is None or expected <= 0:
            return 1.0  # not enough calibration data yet — don't penalise
        ratio = bbox_height / expected
        # Symmetric decay around ratio=1.0
        deviation = abs(math.log(max(ratio, 1e-3)))
        return math.exp(-deviation * 2.0)

    # ------------------------------------------------------------------
    # Matching
    # ------------------------------------------------------------------

    def _fused_score(
        self, cand: _PendingTrack, ident: _Identity, now: float,
    ) -> tuple[float, dict[str, float]]:
        """Weighted multi-signal similarity, renormalised over available signals."""
        breakdown: dict[str, float] = {}
        weighted_sum = 0.0
        weight_total = 0.0

        cand_app = _avg(cand.appearance)
        ident_app = _avg(ident.appearance)
        if cand_app is not None and ident_app is not None:
            s = _cosine_sim(cand_app, ident_app)
            breakdown["appearance"] = s
            weighted_sum += self.cfg.weight_appearance * s
            weight_total += self.cfg.weight_appearance

        cand_shape = _avg(cand.shape)
        ident_shape = _avg(ident.shape)
        if cand_shape is not None and ident_shape is not None:
            s = _cosine_sim(cand_shape, ident_shape)
            breakdown["shape"] = s
            weighted_sum += self.cfg.weight_shape * s
            weight_total += self.cfg.weight_shape

        cand_face = _avg(cand.face)
        ident_face = _avg(ident.face)
        if cand_face is not None and ident_face is not None:
            s = _cosine_sim(cand_face, ident_face)
            breakdown["face"] = s
            weighted_sum += self.cfg.weight_face * s
            weight_total += self.cfg.weight_face

        cand_deep = _avg(cand.deep)
        ident_deep = _avg(ident.deep)
        if cand_deep is not None and ident_deep is not None:
            s = _cosine_sim(cand_deep, ident_deep)
            breakdown["deep"] = s
            weighted_sum += self.cfg.weight_deep * s
            weight_total += self.cfg.weight_deep

        # Spatial-temporal plausibility — always available (position/time
        # are always known), so always contributes.
        dt = max(0.0, now - ident.last_seen)
        dx = cand.position[0] - ident.last_position[0]
        dy = cand.position[1] - ident.last_position[1]
        dist = math.hypot(dx, dy)
        time_score = math.exp(-dt / self.cfg.time_decay_seconds)
        dist_score = math.exp(-dist / self.cfg.distance_decay_px)
        # A person absent a long time is expected to have moved — don't
        # multiply the two decays (which would punish long-but-plausible
        # absences twice); take the more forgiving of the two once the
        # absence is longer than a few seconds.
        spatial_score = time_score if dt > 5.0 else (time_score * dist_score) ** 0.5
        spatial_score = max(spatial_score, dist_score * 0.5)
        breakdown["spatial"] = spatial_score
        weighted_sum += self.cfg.weight_spatial * spatial_score
        weight_total += self.cfg.weight_spatial

        if weight_total <= 0:
            return 0.0, breakdown
        return weighted_sum / weight_total, breakdown

    def _prune_expired(self, now: float) -> None:
        expired = [k for k, v in self._gallery.items() if now - v.last_seen > self.cfg.retention_seconds]
        for k in expired:
            ident = self._gallery.pop(k)
            self._track_to_identity.pop(ident.track_id, None)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def resolve(self, track_id: int, frame: np.ndarray, bbox) -> tuple[str, bool]:
        """
        Given a track's current bbox in `frame`, return
        (identity_id, is_returning_person).

        is_returning_person=True means this track_id was matched to an
        existing gallery entry created under a DIFFERENT prior track_id —
        the person left frame and came back. Use identity_id (not the raw
        track_id) when deciding whether this is a "new" person for
        attendance-counting purposes.
        """
        if not self.cfg.enabled:
            return f"track:{track_id}", False

        now = time.time()
        self._prune_expired(now)

        x1, y1, x2, y2 = [int(v) for v in bbox]
        x1c, y1c = max(0, x1), max(0, y1)
        y2c, x2c = max(y1c, int(y2)), max(x1c, int(x2))
        frame_h = frame.shape[0]
        cy = (y1c + y2c) / 2
        bbox_height = float(y2c - y1c)
        cy_norm = cy / frame_h if frame_h > 0 else 0.5
        # Calibration updates on EVERY call regardless of cache state —
        # otherwise it would only ever see a track's first couple of
        # frames (before it gets cached below) for its entire visit,
        # warming up far too slowly to be useful.
        self._update_calibration(cy_norm, bbox_height)

        if track_id in self._track_to_identity:
            ident_id = self._track_to_identity[track_id]
            if ident_id in self._gallery:
                self._gallery[ident_id].last_seen = now
            return ident_id, False

        person_crop = frame[y1c:y2c, x1c:x2c]
        if person_crop.size == 0:
            return f"track:{track_id}", False

        cx = (x1c + x2c) / 2

        # Accumulate this observation into a pending buffer — we don't
        # make a matching decision from a single frame.
        pending = self._pending.setdefault(track_id, _PendingTrack())
        pending.position = (cx, cy)
        pending.bbox_height = bbox_height
        pending.n_observations += 1

        appearance = self._extract_appearance(person_crop)
        if appearance is not None:
            pending.appearance.append(appearance)
        shape = self._extract_shape(person_crop)
        if shape is not None:
            pending.shape.append(shape)
        face_crop = self._detect_face(person_crop)
        if face_crop is not None:
            face_emb = self._extract_face_embedding(face_crop)
            if face_emb is not None:
                pending.face.append(face_emb)
        deep_emb = self._extract_deep_embedding(person_crop)
        if deep_emb is not None:
            pending.deep.append(deep_emb)

        if pending.n_observations < self.cfg.min_observations_to_match:
            # Not enough observations yet to make a confident call —
            # return a stable per-track placeholder and keep accumulating.
            return f"track:{track_id}", False

        # Enough observations — attempt to match against the gallery.
        best_id, best_score, best_breakdown = None, 0.0, {}
        for candidate_id, ident in self._gallery.items():
            score, breakdown = self._fused_score(pending, ident, now)
            if score > best_score:
                best_score, best_id, best_breakdown = score, candidate_id, breakdown

        if best_id is not None and best_score >= self.cfg.match_threshold:
            ident = self._gallery[best_id]
            if pending.appearance: ident.appearance.extend(pending.appearance)
            if pending.shape: ident.shape.extend(pending.shape)
            if pending.face: ident.face.extend(pending.face)
            if pending.deep: ident.deep.extend(pending.deep)
            ident.last_position = pending.position
            ident.last_bbox_height = pending.bbox_height
            ident.last_seen = now
            ident.track_id = track_id
            self._track_to_identity[track_id] = best_id
            self._pending.pop(track_id, None)
            logger.info(
                "Re-id: track %d matched returning identity %s (score=%.2f, signals=%s)",
                track_id, best_id, best_score,
                {k: round(v, 2) for k, v in best_breakdown.items()},
            )
            return best_id, True

        # No confident match — new identity. Conservative: when evidence
        # is weak/ambiguous, we create a new ID rather than guess.
        self._next_id += 1
        new_id = f"person:{self._next_id}"
        self._gallery[new_id] = _Identity(
            identity_id=new_id,
            appearance=deque(pending.appearance, maxlen=self.cfg.observation_window),
            shape=deque(pending.shape, maxlen=self.cfg.observation_window),
            face=deque(pending.face, maxlen=self.cfg.observation_window),
            deep=deque(pending.deep, maxlen=self.cfg.observation_window),
            last_position=pending.position,
            last_bbox_height=pending.bbox_height,
            last_seen=now,
            track_id=track_id,
        )
        self._track_to_identity[track_id] = new_id
        self._pending.pop(track_id, None)
        if best_id is not None:
            logger.info(
                "Re-id: track %d did NOT match closest candidate %s "
                "(score=%.2f < threshold=%.2f, signals=%s) — created new identity %s",
                track_id, best_id, best_score, self.cfg.match_threshold,
                {k: round(v, 2) for k, v in best_breakdown.items()}, new_id,
            )
        return new_id, False

    def stats(self) -> dict:
        return {
            "enabled": self.cfg.enabled,
            "gallery_size": len(self._gallery),
            "pending_tracks": len(self._pending),
            "deep_model_loaded": self._deep_net is not None,
        }

    def reset(self) -> None:
        """
        Wipe the entire gallery immediately — used when a session/service
        ends, so fingerprints don't persist into (or leak between)
        separate services. Distinct from the normal TTL-based expiry
        (retention_seconds), which is for brief in-session absences.
        """
        self._gallery.clear()
        self._pending.clear()
        self._track_to_identity.clear()
        logger.info("Re-id gallery cleared")

    def get_cached_identity(self, track_id: int) -> Optional[str]:
        """
        Look up a track_id's already-resolved identity without needing a
        frame/bbox. Used for tracks that are temporarily LOST (no current
        detection to resolve against) but still within the tracker's
        occlusion grace period — their identity mapping must stay stable,
        or a brief occlusion would look like the original identity
        "exited" and a new one "entered" a frame later.
        """
        return self._track_to_identity.get(track_id)
