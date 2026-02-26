#!/usr/bin/env bash
set -euo pipefail
LOCK="/data/.refresh.lock"
if [ -f "$LOCK" ]; then
  echo "Refresh already running, exiting."
  exit 0
fi
trap 'rm -f "$LOCK"' EXIT
date > "$LOCK"
echo "[$(date)] Starting refresh..."
npm run index
npm run score
echo "[$(date)] Refresh complete."
