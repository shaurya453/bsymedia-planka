#!/usr/bin/env bash
# Runs the import CLI inside a throwaway container built from the
# invite-service image, which already has network access to `planka` and
# `postgres` plus the `pg` package - avoids installing new dependencies or
# publishing new ports for what is a one-off migration tool.
#
# Usage: ./run.sh <adapter> "<path-to-export-file>" --gap-analysis|--dry-run|--apply|--verify=<boardId>
set -euo pipefail

ADAPTER="$1"
FILE="$2"
shift 2

cd "$(dirname "$0")/../.."   # repo root, so docker compose picks up docker-compose.yml + .env

docker compose run --rm --no-deps \
  -e NODE_PATH=/app/node_modules \
  -v "$(pwd)/scripts/import:/import" \
  -v "${FILE}:/data/export.json:ro" \
  invite-service \
  node --max-old-space-size=4096 /import/cli.js "$ADAPTER" --file /data/export.json "$@"
