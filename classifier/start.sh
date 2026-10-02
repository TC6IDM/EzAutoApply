#!/usr/bin/env sh
# Starts Laya (laya-serve) for EzAutoApply at http://127.0.0.1:8000 (macOS / Linux).
# First run creates classifier/.venv and installs CPU-only PyTorch and Laya.
#   ./start.sh                  # defaults
#   LAYA_API_KEY=secret PORT=8001 ./start.sh
set -e
here="$(cd "$(dirname "$0")" && pwd)"
venv="$here/.venv"
port="${PORT:-8000}"
model="${MODEL:-typed-decisions}"

if [ ! -x "$venv/bin/python" ]; then
  echo "Creating the Python virtual environment (first run only)..."
  python3 -m venv "$venv"
  "$venv/bin/python" -m pip install --upgrade pip
  "$venv/bin/python" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
  "$venv/bin/python" -m pip install -r "$here/requirements.txt"
fi

# Check the port before loading the model, so a clash gets a clear message instead of a socket error.
if "$venv/bin/python" -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1', $port)) == 0 else 1)"; then
  if curl -fs -m 3 "http://127.0.0.1:$port/health" | grep -q '"status":"ok"'; then
    echo "Laya is already running on http://127.0.0.1:$port. Nothing to do."
    exit 0
  fi
  echo "Port $port is already in use by another program."
  echo "Close it, or start Laya on another port: PORT=8001 ./start.sh (then set http://127.0.0.1:8001 in EzAutoApply's Settings)."
  exit 1
fi

# Bind to localhost only; laya-serve's default (0.0.0.0) would expose it to your network.
export LAYA_HOST=127.0.0.1 LAYA_PORT="$port" LAYA_DEVICE="${LAYA_DEVICE:-cpu}" LAYA_PRELOAD=1 LAYA_MODELS="$model"
echo "Starting Laya on http://127.0.0.1:$port (checkpoint: $model). Press Ctrl+C to stop."
# python -m instead of bin/laya-serve, whose shebang hard-codes the venv path.
exec "$venv/bin/python" -m laya.serve
