#!/usr/bin/env bash
#
# Run a Prisma command against the production database from a laptop.
#
# Why this exists: DATABASE_URL in .env points at the Coolify-internal Docker
# service name (o4g2cpls648gnz0f1he7be7c). That name resolves only inside the
# server's Docker network, so any prisma command run locally fails with
# "P1001: Can't reach database server". The container's 5432 is also NOT
# published on the host, so a tunnel has to target the container's Docker IP
# rather than localhost on the server.
#
# Usage:
#   ./scripts/db-tunnel.sh migrate status
#   ./scripts/db-tunnel.sh migrate deploy
#
# The credential is only ever read from .env into a variable — never printed,
# never passed on a command line where it would land in shell history or ps.

set -euo pipefail

SSH_KEY="${JONGO_SSH_KEY:-$HOME/.ssh/jongo_tunnel_key}"
SSH_HOST="${JONGO_SSH_HOST:-5.78.216.68}"
DB_CONTAINER="${JONGO_DB_CONTAINER:-o4g2cpls648gnz0f1he7be7c}"
LOCAL_PORT="${JONGO_DB_LOCAL_PORT:-5433}"

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "error: .env not found; run this from the jongo-os checkout." >&2
  exit 1
fi

# Resolve the container's IP on the Docker bridge. The host cannot resolve the
# service name either, so the tunnel must point at an address.
DB_IP=$(ssh -i "$SSH_KEY" -o BatchMode=yes "root@$SSH_HOST" \
  "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $DB_CONTAINER" \
  | tr -d '[:space:]')

if [ -z "$DB_IP" ]; then
  echo "error: could not resolve the IP of container $DB_CONTAINER." >&2
  echo "       Is it running? ssh root@$SSH_HOST docker ps | grep $DB_CONTAINER" >&2
  exit 1
fi

ssh -i "$SSH_KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -fN \
  -L "$LOCAL_PORT:$DB_IP:5432" "root@$SSH_HOST"
TUNNEL_PID=$(pgrep -f "$LOCAL_PORT:$DB_IP:5432" | head -1)

# Always tear the tunnel down, including on failure — a forgotten background
# tunnel to the production database is exactly the thing not to leave lying open.
cleanup() {
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- \
  | sed "s#@$DB_CONTAINER:5432#@localhost:$LOCAL_PORT#")"
export DATABASE_URL

case "$DATABASE_URL" in
  *"localhost:$LOCAL_PORT"*) ;;
  *) echo "error: DATABASE_URL in .env does not point at $DB_CONTAINER:5432; refusing to guess." >&2; exit 1 ;;
esac

echo "Tunnel up on localhost:$LOCAL_PORT -> $DB_IP:5432 (container $DB_CONTAINER)"
echo "Running: prisma $*"
echo
npx prisma "$@"
