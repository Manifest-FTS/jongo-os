#!/usr/bin/env bash
# run-all-reconciliations.sh
# Wrapper to find all WordPress services and reconcile them

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRIPT_DIR

# Find all containers that look like WordPress and extract their coolify.serviceId
# (Matching 'wordpress' in image or name, or specific label if known)
UUIDS=$(docker ps --filter "ancestor=wordpress" --format '{{.Label "coolify.serviceId"}}' 2>/dev/null | grep -v '^$')

# Fallback to older coolify compose label if empty
if [[ -z "$UUIDS" ]]; then
    UUIDS=$(docker ps --filter "ancestor=wordpress" --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null | grep -v '^$')
fi

# Fallback filtering by container name (e.g. contains 'wordpress')
if [[ -z "$UUIDS" ]]; then
    UUIDS=$(docker ps --filter "name=wordpress" --format '{{.Label "coolify.serviceId"}}' 2>/dev/null | grep -v '^$')
fi

# Deduplicate
UUIDS=$(echo "$UUIDS" | sort -u)

if [[ -z "$UUIDS" ]]; then
    echo "No WordPress services found on this host."
    exit 0
fi

for uuid in $UUIDS; do
    echo "Starting reconciliation for $uuid..."
    "${SCRIPT_DIR}/reconcile-wordpress-service.sh" "$uuid" || echo "Reconciliation failed for $uuid"
done

exit 0
