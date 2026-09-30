"""
Unit tests for ai.reid.face_reid.

The key invariants we care about:
  1. A brand-new track without enough observations returns a stable
     placeholder identity (not spuriously matched to gallery).
  2. Once a track has enough observations, a similar re-appearance is
     matched to the SAME identity (correct re-id).
  3. A totally different-looking person re-appearance gets a NEW
     identity (no false merge — the conservative-merging invariant).
  4. reset() wipes the entire gallery.

We build small synthetic person crops so the tests are deterministic
and don't require any real image data.
"""

from __future__ import annotations

import numpy as np
import pytest

from ai.reid.face_reid import FaceReId, FaceReIdConfig


@pytest.fixture
def cfg() -> FaceReIdConfig:
    return FaceReIdConfig(
        enabled=True,
        retention_seconds=600,
        match_threshold=0.60,     # a bit lower than default so the tests aren't flaky
        min_observations_to_match=2,
        observation_window=4,
    )


def _crop(color: tuple[int, int, int], h: int = 120, w: int = 60) -> np.ndarray:
    """Solid-colour BGR crop — good enough for the HSV/HOG feature extractors."""
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:] = color
    return img


def _frame(person_crop: np.ndarray, frame_h: int = 720, frame_w: int = 1280,
           x: int = 100, y: int = 200) -> tuple[np.ndarray, list[int]]:
    """Embed the crop into a full frame at (x, y). Returns (frame, bbox_xyxy)."""
    frame = np.full((frame_h, frame_w, 3), 30, dtype=np.uint8)  # dark grey background
    h, w = person_crop.shape[:2]
    frame[y:y + h, x:x + w] = person_crop
    return frame, [x, y, x + w, y + h]


def test_placeholder_id_before_enough_observations(cfg):
    reid = FaceReId(cfg)
    frame, bbox = _frame(_crop((10, 200, 30)), x=100, y=200)
    ident, returning = reid.resolve(track_id=1, frame=frame, bbox=bbox)
    assert ident.startswith("track:"), "Should return a stable per-track placeholder before enough obs"
    assert returning is False


def test_returning_person_is_matched(cfg):
    """Same-coloured person, different track_id → should reconcile to the same identity."""
    reid = FaceReId(cfg)
    red_crop = _crop((10, 30, 200))  # blue in BGR is a distinctive hue

    # Track 1 — establish an identity with several observations
    for _ in range(cfg.min_observations_to_match + 1):
        frame, bbox = _frame(red_crop, x=100, y=200)
        first_id, _ = reid.resolve(track_id=1, frame=frame, bbox=bbox)

    assert not first_id.startswith("track:"), "Identity should have resolved past the placeholder"

    # Track 2 — the same person returns after leaving frame, new track_id assigned
    for _ in range(cfg.min_observations_to_match + 1):
        frame, bbox = _frame(red_crop, x=120, y=200)
        second_id, returning = reid.resolve(track_id=2, frame=frame, bbox=bbox)

    assert second_id == first_id, "Same-looking person should match the previous identity"
    assert returning is True


def test_different_person_gets_new_identity(cfg):
    """Very different appearance → should NOT be merged into the same identity."""
    reid = FaceReId(cfg)

    for _ in range(cfg.min_observations_to_match + 1):
        f, b = _frame(_crop((10, 30, 200)), x=100, y=200)   # blue
        first_id, _ = reid.resolve(track_id=1, frame=f, bbox=b)

    for _ in range(cfg.min_observations_to_match + 1):
        f, b = _frame(_crop((200, 200, 10)), x=800, y=200)  # cyan, far away
        second_id, returning = reid.resolve(track_id=2, frame=f, bbox=b)

    assert second_id != first_id, "Very different-looking people must not be merged"
    assert returning is False


def test_reset_wipes_gallery(cfg):
    reid = FaceReId(cfg)
    for _ in range(cfg.min_observations_to_match + 1):
        f, b = _frame(_crop((10, 30, 200)))
        reid.resolve(track_id=1, frame=f, bbox=b)
    assert reid.stats()["gallery_size"] >= 1

    reid.reset()
    assert reid.stats()["gallery_size"] == 0
    assert reid.stats()["pending_tracks"] == 0
