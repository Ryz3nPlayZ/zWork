#!/bin/sh
set -eu

attempts=0
until /app/node_modules/.bin/better-auth migrate --config ./config.ts --yes; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 20 ]; then
    echo "better-auth migration failed after $attempts attempts" >&2
    exit 1
  fi
  sleep 2
done

exec bun run index.ts
