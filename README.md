# Kyro — AI-Powered Attendance & Smart Seating Intelligence

Kyro is a production-grade, GPU-accelerated computer vision platform that monitors crowd attendance and seat occupancy in real time. Designed for churches, it scales to stadiums, theatres, and conference centres.

## Architecture

```
kyro/
├── ai/               Python AI engine (YOLO, ByteTrack, seat detection)
├── backend/          FastAPI REST + WebSocket server
├── dashboard/        Next.js usher & analytics dashboard
├── docker/           Docker Compose orchestration
└── docs/             Architecture & API documentation
```

## Quick Start

```bash
# 1. Clone and enter
cd Kyro

# 2. Start all services
docker compose -f docker/docker-compose.yml up --build

# 3. Open dashboard
open http://localhost:3000

# 4. API docs
open http://localhost:8000/docs
```

## Requirements

- Docker + Docker Compose
- NVIDIA GPU (optional — CPU fallback available)
- NVIDIA Container Toolkit (for GPU acceleration)

## Documentation

See `docs/` for:
- Architecture overview
- AI pipeline design
- API reference
- Deployment guide
- Scaling guide
