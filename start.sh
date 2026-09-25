#!/usr/bin/env bash
# Start the server in the background (no admin rights needed). Log: data/server.log
cd "$(dirname "$0")"
if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then
  echo "Already running (PID $(cat data/server.pid))."; exit 0
fi
mkdir -p data
nohup ./run.sh >> data/server.log 2>&1 &
echo $! > data/server.pid
sleep 5
if kill -0 "$(cat data/server.pid)" 2>/dev/null; then
  echo "Started (PID $(cat data/server.pid)). Open http://localhost:8000 - log: data/server.log"
else
  echo "Failed to start - last lines of data/server.log:"; tail -20 data/server.log; exit 1
fi
