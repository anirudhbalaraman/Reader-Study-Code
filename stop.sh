#!/usr/bin/env bash
# Stop the background server started with start.sh
cd "$(dirname "$0")"
if [ -f data/server.pid ] && kill "$(cat data/server.pid)" 2>/dev/null; then
  rm -f data/server.pid; echo "Stopped."
else
  pkill -f "python run.py" && echo "Stopped." || echo "Not running."
  rm -f data/server.pid
fi
