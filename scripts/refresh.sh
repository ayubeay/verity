#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "[$(date)] Starting VERITY refresh..."
npm run index 2>&1
npm run score 2>&1

curl -s -X POST https://verity-production.up.railway.app/admin/upload-scores \
  -H "x-admin-secret: ${ADMIN_SECRET}" \
  -H "Content-Type: text/plain" \
  --data-binary @data/ais_scores.jsonl

echo "[$(date)] Refresh complete."
