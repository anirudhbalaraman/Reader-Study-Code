#!/usr/bin/env bash
# Admin helpers, e.g.  ./manage.sh create-admin anirudh   |   ./manage.sh check-data
cd "$(dirname "$0")"
exec .venv/bin/python -m app.manage "$@"
