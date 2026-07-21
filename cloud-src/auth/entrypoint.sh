#!/bin/sh
set -eu

if [ -z "${SMTP_HOST:-}" ] || [ -z "${SMTP_USER:-}" ] || [ -z "${SMTP_PASS:-}" ]; then
  echo "WARNING: SMTP_HOST/SMTP_USER/SMTP_PASS are not all set — email/password auth will fail verification (verification emails cannot be sent)." >&2
fi

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
