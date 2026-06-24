#!/bin/bash
# SSH into the zWork production server
# Usage: ./ssh-connect.sh

set -euo pipefail

HOST="${ZWORK_SERVER_HOST:-api.tryzwork.app}"
USER="${ZWORK_SERVER_USER:-ubuntu}"
KEY="${ZWORK_SERVER_KEY:-${HOME}/.ssh/zwork-server}"

if [ ! -f "$KEY" ]; then
  echo "SSH key not found at $KEY"
  echo "Set ZWORK_SERVER_KEY to point to your key, or place it at ~/.ssh/zwork-server"
  exit 1
fi

exec ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$USER@$HOST" "$@"
