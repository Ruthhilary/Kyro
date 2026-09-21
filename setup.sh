#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kyro — One-time local dev setup
# Run once: bash setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Kyro — Local Dev Setup                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Python virtual environment ────────────────────────────────────────────
echo "▶ Creating Python virtual environment..."
cd "$ROOT"
python3 -m venv .venv
source .venv/bin/activate

echo "▶ Installing AI engine dependencies..."
pip install --upgrade pip -q
pip install -r ai/requirements.txt -q

echo "▶ Installing backend dependencies..."
pip install -r backend/requirements.txt -q

# ── 2. Dashboard node modules ─────────────────────────────────────────────────
echo "▶ Installing dashboard npm packages..."
cd "$ROOT/dashboard"
npm install --silent

# ── 3. Env file ────────────────────────────────────────────────────────────────
cd "$ROOT"
if [ ! -f .env ]; then
    cp .env.example .env
    echo "▶ Created .env from .env.example — edit it before production"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next: open 3 terminals in Kyro/Kyro/ and run:"
echo ""
echo "  Terminal 1 — Infrastructure (Postgres + Redis):"
echo "    docker compose -f docker/docker-compose.yml up postgres redis"
echo ""
echo "  Terminal 2 — Backend API:"
echo "    source .venv/bin/activate"
echo "    uvicorn backend.main:app --reload --port 8000"
echo ""
echo "  Terminal 3 — Demo stream (simulated people + live updates):"
echo "    source .venv/bin/activate"
echo "    python -m ai.demo_stream --camera-id cam-01 --capacity 20"
echo ""
echo "  Terminal 4 — Dashboard:"
echo "    cd dashboard && npm run dev"
echo ""
echo "  Then open: http://localhost:3000"
echo "  Login: admin / kyro-admin-change-me"
echo "  API docs: http://localhost:8000/docs"
echo ""
