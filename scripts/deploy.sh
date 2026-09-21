#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kyro — Deploy script
# Usage:
#   ./scripts/deploy.sh              # build + start with .env.prod
#   ./scripts/deploy.sh --ngrok      # also open an ngrok tunnel on port 80
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMPOSE="docker compose -f $ROOT/docker/docker-compose.prod.yml"
ENV_FILE="$ROOT/.env.prod"
NGROK=false

for arg in "$@"; do
  [[ "$arg" == "--ngrok" ]] && NGROK=true
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌  $ENV_FILE not found. Copy .env.prod and fill in your values."
  exit 1
fi

echo "▶  Building images..."
$COMPOSE --env-file "$ENV_FILE" build

echo "▶  Starting services..."
$COMPOSE --env-file "$ENV_FILE" up -d

echo "▶  Waiting for backend health check..."
for i in $(seq 1 20); do
  if curl -sf http://localhost/health > /dev/null 2>&1; then
    echo "✅  Backend healthy"
    break
  fi
  sleep 2
done

echo ""
echo "✅  Kyro is running at http://localhost"
echo "   API docs: http://localhost/docs"

if $NGROK; then
  if ! command -v ngrok &> /dev/null; then
    echo "⚠️  ngrok not found. Install from https://ngrok.com/download"
    echo "   Then run: ngrok http 80"
  else
    echo ""
    echo "▶  Starting ngrok tunnel..."
    ngrok http 80 &
    sleep 3
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
      | python3 -c "import sys,json; t=json.load(sys.stdin)['tunnels']; print(next(x['public_url'] for x in t if x['proto']=='https'))" 2>/dev/null || echo "")
    if [[ -n "$NGROK_URL" ]]; then
      echo "✅  Public URL: $NGROK_URL"
      echo "   Share this link — works on any phone or device"
    else
      echo "   Check http://localhost:4040 for your ngrok URL"
    fi
  fi
fi
