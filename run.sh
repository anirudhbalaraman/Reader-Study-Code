#!/usr/bin/env bash
# Start the reader study server (macOS + Linux). First run creates a virtualenv.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
if [ ! -d .venv ]; then
  echo "Creating virtual environment…"
  "$PY" -m venv .venv
  .venv/bin/pip install --upgrade pip -q
  .venv/bin/pip install -r requirements.txt -q
fi
[ -f config.yaml ] || { cp config.example.yaml config.yaml; echo "Created config.yaml - edit it to point at your data."; }
exec .venv/bin/python run.py
