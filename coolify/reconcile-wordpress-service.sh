#!/usr/bin/env bash
# reconcile-wordpress-service.sh
# Main orchestrator for WordPress Auto-Ops reconciliation

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRIPT_DIR

source "${SCRIPT_DIR}/lib/logging.sh"
source "${SCRIPT_DIR}/lib/docker.sh"
source "${SCRIPT_DIR}/lib/wordpress.sh"
source "${SCRIPT_DIR}/lib/validation.sh"

export SERVICE_UUID="${1:-}"

if [[ -z "$SERVICE_UUID" ]]; then
    echo "Usage: $0 <SERVICE_UUID>"
    exit 1
fi

log_info "reconciliation-start" "service=${SERVICE_UUID}"

# 1. Discover Container
CONTAINER_ID=$(discover_container "$SERVICE_UUID") || exit 1

# 2. Wait for container to be ready (Retry Logic)
if ! wait_for_container "$CONTAINER_ID"; then
    log_error "reconciliation" "status=failed reason=container-not-ready"
    exit 1
fi

# 3. Discover desired domain from Coolify labels
TARGET_DOMAIN=$(get_coolify_domain "$CONTAINER_ID") || exit 1
log_info "domain-discovery" "target_domain=${TARGET_DOMAIN}"

# 4. Apply upload limits using existing script
LIMITS_SCRIPT="${SCRIPT_DIR}/apply-upload-limits.sh"
if [[ -f "$LIMITS_SCRIPT" && -x "$LIMITS_SCRIPT" ]]; then
    log_info "upload-limits" "status=invoking-existing-script"
    "$LIMITS_SCRIPT" "$SERVICE_UUID" || log_error "upload-limits" "status=failed"
else
    log_info "upload-limits" "status=skipped reason=script-not-found"
fi

# 5. Check actual WP domain (Idempotency check)
if ! wp_check_prerequisites "$CONTAINER_ID"; then
    log_error "reconciliation" "status=failed reason=wp-prerequisites-not-met"
    exit 1
fi

CURRENT_HOME=$(wp_get_option "$CONTAINER_ID" "home" | sed -e 's|^https*://||' -e 's|/$||')
CURRENT_SITEURL=$(wp_get_option "$CONTAINER_ID" "siteurl" | sed -e 's|^https*://||' -e 's|/$||')

log_info "domain-check" "current_home=${CURRENT_HOME} current_siteurl=${CURRENT_SITEURL} target_domain=${TARGET_DOMAIN}"

# 6. Pre-Validation
validate_site_health "$TARGET_DOMAIN" "pre-validation"

# 7. Domain Reconciliation (only if needed)
if [[ "$CURRENT_HOME" != "$TARGET_DOMAIN" || "$CURRENT_SITEURL" != "$TARGET_DOMAIN" ]]; then
    log_info "reconciliation" "status=domain-mismatch action=reconciling"
    
    # We use CURRENT_HOME as OLD_DOMAIN, fallback to CURRENT_SITEURL if empty
    OLD_DOMAIN="${CURRENT_HOME:-$CURRENT_SITEURL}"
    
    if [[ -n "$OLD_DOMAIN" ]]; then
        "${SCRIPT_DIR}/reconcile-wp-domain-change.sh" "$SERVICE_UUID" "$OLD_DOMAIN" "$TARGET_DOMAIN"
    else
        log_error "reconciliation" "status=failed reason=cannot-determine-old-domain"
    fi
else
    log_info "reconciliation" "status=skipped reason=domain-already-matches"
fi

# 8. Post-Validation
validate_site_health "$TARGET_DOMAIN" "post-validation"

log_info "reconciliation-end" "service=${SERVICE_UUID} status=success"
exit 0
