<div align="center">

# Kyro

**AI-powered attendance, seating, and venue intelligence for real-world churches.**

Real-time computer vision that counts people, tracks who's returning, understands your stage and choir, and turns your camera feeds into decisions your team can act on.

[Live demo →](https://kyro.kharischurch.com/)

![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111-009688?style=flat-square&logo=fastapi&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-14-000000?style=flat-square&logo=next.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)
![YOLOv8](https://img.shields.io/badge/YOLOv8-Person%20Detection-00FFFF?style=flat-square)
![License](https://img.shields.io/badge/License-Proprietary-lightgrey?style=flat-square)

</div>

---

## What Kyro is

Counting people in a service is harder than it looks. A camera high in the balcony sees hair, not faces. A choir in matching uniforms breaks every off-the-shelf face recogniser. Someone stepping out for two minutes shouldn't reset the count. And if you get any of it *wrong*, the numbers on the pastor's screen mean nothing.

Kyro is a full-stack platform that does this properly:

- **A vision pipeline** that combines person detection, motion tracking, and multi-signal re-identification so a person who leaves and comes back is recognised — not double-counted.
- **A backend** that turns raw camera streams into structured attendance events, protects the API with real authentication, and pushes updates over WebSockets.
- **A dashboard** that shows live attendance, seat maps, camera feeds, rota assignments, and alerts — designed for a Sunday morning, not a data analyst.

It runs in Docker, uses standard USB or RTSP cameras, and is designed around real church operations — altar calls, ushers, rotating volunteers, capacity limits — not generic retail people-counting.

---

## Why it's different

| Problem in most people-counting systems | How Kyro handles it |
|---|---|
| Recounts the same person after they briefly leave frame | Multi-signal re-identification (appearance + body shape + optional deep embedding + spatial plausibility) with a conservative match threshold |
| Merges two similarly-dressed people (choir, uniforms) into one identity | Explicitly designed to **over-split rather than mis-merge** — extra IDs are cheaper than losing a real person |
| Counts a pastor at the pulpit as "seated in row A" | Stage / altar / choir zones are first-class; seats inside them are held, not counted as normal attendance |
| Confuses a toilet break with a departure | Ignore zones tell the pipeline to skip counting activity in those areas |
| Wipes state between camera crashes | Kalman-filtered tracking with occlusion grace period; graceful shutdown flushes cleanly |
| Ships with test credentials | Refuses to start if the JWT secret is still the default; passwords hashed with PBKDF2-SHA256 (260k iterations); login rate-limited per IP |

---

## Architecture

```
                   ┌──────────────────────────┐
                   │  Cameras (USB / RTSP)    │
                   └──────────────┬───────────┘
                                  │  frames
                                  ▼
   ┌──────────────────────────────────────────────────────┐
   │                Vision Worker (ai/)                   │
   │                                                      │
   │  YOLOv8  →  ByteTrack  →  Face Re-ID  →  Seat/Zone  │
   │  Detect     +Kalman        Multi-signal  Occupancy   │
   └──────────────────────────┬───────────────────────────┘
                              │  attendance events (Redis pub/sub)
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │              FastAPI Backend (backend/)              │
   │                                                      │
   │  REST API · JWT auth · Rate limit · WebSockets       │
   └──────────┬───────────────────────────────┬───────────┘
              │                               │
              ▼                               ▼
      ┌───────────────┐               ┌───────────────┐
      │  PostgreSQL   │               │     Redis     │
      │  (durable)    │               │  (streaming)  │
      └───────────────┘               └───────────────┘
                              │
                              ▼  live updates over WebSocket
   ┌──────────────────────────────────────────────────────┐
   │             Next.js Dashboard (dashboard/)           │
   │                                                      │
   │  Seat Map · Attendance · Live Cameras · Rota · Users │
   └──────────────────────────────────────────────────────┘
```

One vision worker runs per camera. Everything is stateless outside Postgres and Redis, so it scales horizontally.

---

## Tech stack

**Vision.** Python 3.11 · [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics) · OpenCV · filterpy (Kalman) · optional OSNet ONNX for deep re-id.

**Backend.** FastAPI · SQLAlchemy (async) · Alembic · WebSockets · Redis pub/sub · PBKDF2 password hashing · JWT.

**Dashboard.** Next.js 14 · React 18 · TypeScript · Tailwind CSS · lucide-react.

**Infra.** Docker Compose · PostgreSQL 16 · Redis 7. Deploys to Cloudflare Pages (dashboard) + any Docker host (backend + vision).

---

## Quick start

**Requires:** Docker (with Compose), a webcam or an RTSP camera URL.

```bash
git clone https://github.com/kharis-min-tech/Kyro.git
cd Kyro
cp .env.example .env         # then edit .env — generate secrets with `openssl rand -hex 32`
docker compose -f docker/docker-compose.yml up --build
```

Open **http://localhost:3001** and sign in. The AI pipeline attaches to `/dev/video0` by default; change `STREAM_SOURCE` in `.env` to point at another device or an `rtsp://…` URL.

Prefer to run without Docker? `node start.mjs` at the project root brings up the backend and dashboard on the host, and the launcher installs Python + Node dependencies on first run.

---

## Features

### Live attendance intelligence
Detection, tracking, and re-identification run per frame per camera. The dashboard shows current occupancy, entries, exits, and per-camera trends over WebSockets — no polling. When the pipeline is uncertain (occlusion, low confidence, ambiguous re-id) the operator can review a snapshot and confirm or reject.

### Smart seating
Draw seat layouts directly on a camera snapshot. Each seat has state (`occupied`, `reserved`, `temporarily vacant`, `on stage`, `free`) and confidence. The dashboard visualises this as a live seat map with a per-seat detail panel showing the live feed and the identity currently mapped to it.

### Zones that actually behave differently
Two zone types, both applied end-to-end (pipeline, seat map, counts):
- **Hold-seats zone** (stage / altar / choir) — seats inside are held while anyone is on them.
- **Ignore zone** (exit / toilet / walkway) — activity here doesn't count towards attendance.

The Seat Map surfaces the active zones for each camera in real time; drawing a zone in the Layout Editor immediately reflects on every open view.

### Church-specific workflows
- Rota (planned volunteers hold specific seats during a service)
- Altar-call handling (temporary hold on affected rows without breaking counts)
- OCR ingestion of paper rota sheets
- Multi-camera support with per-camera capacity, zones, and operators

### Alerts
Push-notification alerts on:
- A specific seat becoming available (for ushers)
- Capacity thresholds
- Camera going offline
- Pipeline errors

---

## Configuration

All secrets and knobs live in `.env` (never committed — see `.gitignore`). Copy `.env.example` for the full list. The essentials:

| Variable | Purpose |
|---|---|
| `KYRO_JWT_SECRET` | Signing key for session tokens. **Server refuses to start on the default.** |
| `KYRO_API_KEY` | Machine-to-machine key between vision worker and backend. |
| `KYRO_DASHBOARD_USER` / `KYRO_DASHBOARD_PASS` | Fallback admin account when no DB users exist. |
| `ALLOWED_ORIGINS` | Comma-separated list of origins allowed to call the API. |
| `KYRO_LOGIN_RATE_MAX_HITS` / `_WINDOW_S` | Per-IP login rate limit (default: 10 attempts / 60s). |
| `CAMERA_ID`, `STREAM_SOURCE` | Which camera this vision worker is for. |
| `DETECTION_DEVICE` | `cpu`, `cuda`, or `mps`. |
| `FACE_REID_DEEP_MODEL_PATH` | Optional OSNet ONNX model for stronger re-id. See `ai/reid/face_reid.py`. |

---

## Security

- Passwords hashed with **PBKDF2-HMAC-SHA256** at 260,000 iterations (NIST SP 800-63B baseline).
- JWT sessions with a configurable expiry; server **rejects startup** if the secret is still the default value.
- Login endpoint is **rate-limited per IP** with a sliding window.
- CORS is restricted to explicit origins (`ALLOWED_ORIGINS`) — no wildcard fallback.
- All secrets live in `.env` (git-ignored). `.env.example` documents what to set.
- Face fingerprints are **in-memory only**, expire after 10 minutes idle, and are wiped on session/service end. Nothing biometric is written to disk.

For a production deployment: rotate the default secrets, put the backend behind TLS, and consider Argon2id (via `passlib`) if you want stronger password hashing than PBKDF2.

---

## Project structure

```
Kyro/
├── ai/                     Vision pipeline (per-camera worker)
│   ├── detection/          YOLOv8 person detection
│   ├── tracking/           ByteTrack + Kalman
│   ├── reid/               Multi-signal re-identification
│   ├── seat_detection/     Seat occupancy + zones + movement + rota
│   ├── analytics/          Attendance counting
│   ├── pipeline.py         Orchestrates the stages per frame
│   ├── worker.py           Entry point (one process per camera)
│   └── README.md           Pipeline design decisions
├── backend/                FastAPI service (REST + WebSockets)
│   ├── api/routes/         auth, users, cameras, seats, zones, rota, analytics, push
│   ├── auth/               password hashing, JWT
│   ├── database/           SQLAlchemy models
│   ├── services/           background tasks (redis subscriber, alerts, snapshots)
│   └── websockets/         connection manager
├── dashboard/              Next.js 14 dashboard
│   └── src/app/            attendance, seating, cameras, rota, users, layout-editor, …
├── docker/                 Dockerfiles + docker-compose.yml
├── migrations/             Alembic migrations
├── tests/                  pytest unit tests (tracker + re-id invariants)
├── start.mjs               One-command launcher (backend + dashboard on host)
└── .env.example            Every knob and where to set it
```

---

## Testing

```bash
pytest                       # unit tests for tracker + re-id invariants
cd dashboard && npx tsc --noEmit    # dashboard type-check
cd dashboard && npm run build       # dashboard production build
```

CI runs the same three on every push to `main`.

---

## Deploying

- **Dashboard** → Cloudflare Pages (or Vercel, Netlify). Point it at this repo, build command `cd dashboard && npm install && npm run build`, output directory `dashboard/.next`.
- **Backend** → any Docker host (Fly.io, Railway, Render, a $5 VPS). Uses one Postgres and one Redis. Set `ALLOWED_ORIGINS` to your dashboard URL.
- **Vision worker** → same Docker host as the backend, or a separate machine with a GPU if you want CUDA inference. One container per camera.

---

## Development principles

Because someone will ask.

- **Single responsibility per module.** The pipeline only orchestrates; it never detects, tracks, or classifies on its own.
- **Conservative merging in re-id.** Over-splitting into extra IDs is a much smaller problem than merging two different people into one.
- **Privacy by default.** No biometrics on disk. Face fingerprints are TTL'd and wiped on session end. See the docstring at the top of `ai/reid/face_reid.py`.
- **Fail loudly on startup, gracefully at runtime.** Default JWT secret → refuse to start. Camera drops mid-service → keep processing, mark the camera "offline", carry on.
- **Comments explain *why*, not *what*.** If the code is doing something surprising, there's a comment. If it's obvious, there isn't.

---

## Contributing

Kyro is currently developed by the [Kharis Ministries](https://kharischurch.com) tech team. Bug reports and pull requests are welcome via GitHub. For questions or partnerships, reach out at [tech@kharis.org](mailto:tech@kharis.org).

---

<div align="center">
Built for churches. Designed to be trusted with real people, in a real room, on a real Sunday.
</div>
