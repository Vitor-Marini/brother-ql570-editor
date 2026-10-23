#!/usr/bin/env bash
# Starts the server at http://localhost:8570
set -e
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt; }
exec .venv/bin/uvicorn app.server:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8570}" "$@"
