"""
Unit tests for ai.tracking.bytetrack.

Focus areas (highest bug risk):
  1. Track IDs are assigned monotonically and don't collide after
     tracker re-instantiation in the same process (the fix in this file).
  2. A person moving smoothly across frames keeps the same track_id.
  3. Two people at different positions get different track_ids.
  4. A track that vanishes for < max_age frames stays alive (LOST),
     then is deleted after max_age.
"""

from __future__ import annotations

import numpy as np
import pytest

from ai.config import TrackingConfig
from ai.detection.detector import Detection
from ai.tracking.bytetrack import ByteTracker, Track, TrackState


def det(x1: float, y1: float, x2: float, y2: float, conf: float = 0.9) -> Detection:
    """Build a Detection with pixel bbox [x1,y1,x2,y2]."""
    return Detection(bbox=np.array([x1, y1, x2, y2], dtype=np.float32), confidence=conf, class_id=0)


@pytest.fixture
def cfg() -> TrackingConfig:
    # min_hits=1 so tracks confirm on the first frame — keeps tests short.
    return TrackingConfig(max_age=5, min_hits=1, iou_threshold=0.3,
                          high_thresh=0.6, low_thresh=0.1)


def test_ids_are_monotonic_across_tracker_reinstantiation(cfg):
    """A re-init must NOT reset the id counter — else a stale id from
    the old tracker could be re-used by the new one."""
    t1 = ByteTracker(cfg)
    out = t1.update([det(0, 0, 20, 40)])
    first_id = out[0].track_id

    # Simulate a session-reset that re-creates the tracker in the same process.
    t2 = ByteTracker(cfg)
    out2 = t2.update([det(200, 0, 220, 40)])
    second_id = out2[0].track_id

    assert second_id > first_id, "New tracker must not reuse ids from the old one"


def test_smooth_movement_keeps_same_id(cfg):
    """A person walking one step per frame should stay the same track_id."""
    t = ByteTracker(cfg)
    ids = []
    for step in range(5):
        out = t.update([det(step * 5, 0, step * 5 + 20, 40)])
        assert len(out) == 1
        ids.append(out[0].track_id)
    assert len(set(ids)) == 1, f"Expected one stable id across smooth motion, got {ids}"


def test_two_people_get_two_ids(cfg):
    t = ByteTracker(cfg)
    out = t.update([det(0, 0, 20, 40), det(300, 0, 320, 40)])
    assert len(out) == 2
    assert out[0].track_id != out[1].track_id


def test_brief_occlusion_keeps_track_alive(cfg):
    """< max_age frames without a detection should NOT delete the track."""
    t = ByteTracker(cfg)
    out = t.update([det(0, 0, 20, 40)])
    original_id = out[0].track_id

    # Person vanishes for 3 frames (< max_age=5)
    for _ in range(3):
        t.update([])

    # The track's id must still be remembered by the tracker
    assert original_id in t.active_track_ids, "Track deleted too early during brief occlusion"


def test_long_absence_deletes_track(cfg):
    """> max_age frames without a detection should delete the track."""
    t = ByteTracker(cfg)
    out = t.update([det(0, 0, 20, 40)])
    original_id = out[0].track_id

    for _ in range(cfg.max_age + 3):
        t.update([])

    assert original_id not in t.active_track_ids, "Track kept alive past max_age"
