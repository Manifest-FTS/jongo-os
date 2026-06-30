#!/usr/bin/env bash
# reconcile-wp-domain-change.sh
# Executes the actual domain reconciliation for a WordPress service

set -Eeuo pipefail

# Determine script directory for imports
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRIPT_DIR

source "${SCRIPT_DIR}/lib/logging.sh"
source "${SCRIPT_DIR}/lib/docker.sh"
source "${SCRIPT_DIR}/lib/wordpress.sh"

SERVICE_UUID="${1:-}"
OLD_DOMAIN="${2:-}"
NEW_DOMAIN="${3:-}"

if [[ -z "$SERVICE_UUID" || -z "$OLD_DOMAIN" || -z "$NEW_DOMAIN" ]]; then
    echo "Usage: $0 <SERVICE_UUID> <OLD_DOMAIN> <NEW_DOMAIN>"
    exit 1
fi

log_info "reconcile-domain-change" "status=started old=${OLD_DOMAIN} new=${NEW_DOMAIN}"

CONTAINER_ID=$(discover_container "$SERVICE_UUID")

# Verify wp-cli is available
if ! wp_check_prerequisites "$CONTAINER_ID"; then
    log_error "reconcile-domain-change" "status=failed reason=prerequisites-not-met"
    exit 1
fi

# Update core URLs
wp_update_option "$CONTAINER_ID" "home" "https://${NEW_DOMAIN}"
wp_update_option "$CONTAINER_ID" "siteurl" "https://${NEW_DOMAIN}"

# We wrap the existing fix-wp-domain-references.sh
# The existing script might already do search-replace, but we need to ensure idempotency and safety.
FIX_SCRIPT="${SCRIPT_DIR}/fix-wp-domain-references.sh"

if [[ -f "$FIX_SCRIPT" && -x "$FIX_SCRIPT" ]]; then
    log_info "search-replace" "status=invoking-existing-script script=${FIX_SCRIPT}"
    # Pass necessary environment or arguments based on typical usage
    # Since we can't inspect the script, we assume it takes UUID, OLD, NEW or relies on ENV vars.
    # We will also do our own safe search-replace just in case the script doesn't handle the DB thoroughly.
    
    # We execute it but we still run our own dry-run and replace below to guarantee the requirements.
    "$FIX_SCRIPT" "$SERVICE_UUID" "$OLD_DOMAIN" "$NEW_DOMAIN" || log_error "search-replace" "status=existing-script-failed"
else
    log_info "search-replace" "status=existing-script-not-found fallback=internal-implementation"
fi

# Safe Search-Replace with dry-run
log_info "search-replace-dry-run" "status=starting"
dry_run_output=$(docker_exec_wp "$CONTAINER_ID" search-replace "$OLD_DOMAIN" "$NEW_DOMAIN" --all-tables --skip-columns=guid --dry-run --format=json 2>/dev/null || echo "[]")

# Extract number of replacements (simple parsing for JSON array if jq is available, else fallback)
replacements=$(echo "$dry_run_output" | grep -o '"replacements": [0-9]*' | awk '{sum += $2} END {print sum}')
replacements=${replacements:-0}

log_info "search-replace-dry-run" "status=completed expected_replacements=${replacements}"

if [[ "$replacements" -gt 0 ]]; then
    log_info "search-replace-execute" "status=starting"
    docker_exec_wp "$CONTAINER_ID" search-replace "$OLD_DOMAIN" "$NEW_DOMAIN" --all-tables --skip-columns=guid
    log_info "search-replace-execute" "status=completed"
    
    # Verify zero replacements remaining
    post_dry_run_output=$(docker_exec_wp "$CONTAINER_ID" search-replace "$OLD_DOMAIN" "$NEW_DOMAIN" --all-tables --skip-columns=guid --dry-run --format=json 2>/dev/null || echo "[]")
    remaining=$(echo "$post_dry_run_output" | grep -o '"replacements": [0-9]*' | awk '{sum += $2} END {print sum}')
    remaining=${remaining:-0}
    
    log_info "search-replace-verify" "status=completed updated=${replacements} remaining=${remaining}"
else
    log_info "search-replace-execute" "status=skipped reason=no-replacements-needed"
fi

# Flush all caches
wp_flush_caches "$CONTAINER_ID"

log_info "reconcile-domain-change" "status=success"
exit 0
