#!/usr/bin/env sh
# Personal Info Butler - Local Offline Edition (macOS / Linux launcher)
set -e
cd "$(dirname "$0")"

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python

if ! "$PY" -c 'import flask' >/dev/null 2>&1; then
  echo "[SETUP] Installing the only dependency: Flask ..."
  "$PY" -m pip install -r requirements.txt
fi

echo "Starting local server at http://127.0.0.1:8771/"
echo "Press Ctrl+C to stop. Your notes stay in data/pia.db"
exec "$PY" server.py --open-browser
