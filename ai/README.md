# Kyro AI Pipeline

Per-camera vision pipeline that turns raw frames into structured attendance
data. Each camera runs one `worker` process; the worker owns one
`VisionPipeline`, and the pipeline stitches together the modules below.

## Stages

```
   frame  →  Detector  →  Tracker  →  Re-ID  →  Seat engine  →  Counter  →  Redis / Backend
```

| Stage | Module | What it does |
|-------|--------|--------------|
| 1. Detection    | `detection/detector.py`    | YOLOv8 finds every visible person, returns bounding boxes + confidence. Auto-selects CUDA → MPS → CPU. |
| 2. Tracking     | `tracking/bytetrack.py`    | ByteTrack + Kalman filter. Assigns a `track_id` per person, keeps it stable frame-to-frame, handles occlusion via a `LOST` state with a `max_age` grace period. |
| 3. Re-identification | `reid/face_reid.py`   | Bridges the case where someone leaves the frame and comes back with a new `track_id`. Multi-signal fusion: HSV clothing histogram + HOG body shape + LBP face embedding + optional OSNet ONNX deep embedding + spatial/temporal plausibility. **Conservative**: creates a new identity when unsure rather than merging two different people. |
| 4. Seat occupancy | `seat_detection/occupancy.py` | Matches tracked persons to fixed seat bboxes; classifies each seat as available / occupied / uncertain. |
| 4b. Movement    | `seat_detection/movement.py` | Distinguishes "walking to my seat" from "on stage / at altar / in aisle" so transient presence isn't counted as sitting. |
| 5. Counting     | `analytics/counter.py`     | Maintains total-attendance, entries, exits, and capacity headroom, using the tracker's CONFIRMED+LOST set (so brief occlusions aren't counted as exits) and the re-id `identity_map` (so returning people aren't double-counted). |

## Design decisions

- **One responsibility per module.** The pipeline only orchestrates. Every
  module can be unit-tested in isolation.
- **Fixed-camera calibration.** The re-id module learns "expected bbox
  height at this y-position" online and exposes it to the pipeline for
  human-scale sanity checks.
- **Conservative re-id.** When evidence is ambiguous (e.g. two choir
  members in the same uniform), the pipeline creates a new identity
  instead of merging. An occasional extra ID is a much smaller problem
  than merging two different people into one.
- **Privacy.** Re-id fingerprints are in-memory only, TTL'd to
  `retention_seconds` (default 10 min), wiped on session end, and never
  persisted to disk. See the docstring at the top of `reid/face_reid.py`.
- **Track IDs are process-monotonic.** `Track._id_counter` never resets
  inside a running worker. If the tracker is re-instantiated (session
  reset), new tracks start above the previous max — no collisions with
  ids the re-id gallery still remembers.

## Configuration

All thresholds live in `ai/config.py` and can be overridden via
environment variables (see `.env.example`).

Key knobs:
- `TRACK_MAX_AGE` — how many frames a track stays alive without a match
- `TRACK_MIN_HITS` — how many consecutive detections before a track is CONFIRMED
- `FACE_REID_MATCH_THRESHOLD` — how confident re-id has to be before merging (0.82 default)
- `FACE_REID_DEEP_MODEL_PATH` — path to an optional OSNet ONNX file; if
  present, adds a strong deep embedding signal to the fusion. Not required
  but materially improves accuracy — see the config docstring for where to
  download one.

## Running

```bash
# Local (one camera)
python -m ai.worker --camera-id cam-01 --stream 0

# RTSP stream
python -m ai.worker --camera-id cam-02 --stream rtsp://192.168.1.10/stream

# Via docker-compose (reads CAMERA_ID / STREAM_SOURCE from .env)
docker compose -f docker/docker-compose.yml up vision
```

The worker publishes results to Redis under `vision:results:{camera_id}` and
maintains a health heartbeat at `vision:health:{camera_id}`. The FastAPI
backend subscribes to both.

## Tests

Unit tests for the tracker and re-id modules live in `tests/`. Run with
`pytest`. Add tests for any new pipeline logic — the re-id and tracker are
the most safety-critical code paths.
