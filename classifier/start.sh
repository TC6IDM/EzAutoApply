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

# Bind to localhost only; laya-serve's default (0.0.0.0) would expose it to your network.
export LAYA_HOST=127.0.0.1 LAYA_PORT="$port" LAYA_DEVICE="${LAYA_DEVICE:-cpu}" LAYA_PRELOAD=1 LAYA_MODELS="$model"
echo "Starting Laya on http://127.0.0.1:$port (checkpoint: $model). Press Ctrl+C to stop."
# python -m instead of bin/laya-serve, whose shebang hard-codes the venv path.
exec "$venv/bin/python" -m laya.serve
