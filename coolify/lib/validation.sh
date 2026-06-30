#!/usr/bin/env bash
# validation.sh
# Validation library for Coolify WordPress Auto-Ops

set -Eeuo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/logging.sh"

validate_endpoint() {
    local url="$1"
    local expected_code="$2"
    local max_retries=3
    
    local status_code
    for i in $(seq 1 $max_retries); do
        status_code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$url" || echo "000")
        if [[ "$status_code" == "$expected_code" ]]; then
            return 0
        fi
        sleep 2
    done
    
    echo "$status_code"
    return 1
}

validate_redirect() {
    local url="$1"
    local expected_target="$2"
    
    local redirect_target
    redirect_target=$(curl -s -o /dev/null -w "%{redirect_url}" -m 10 "$url" || echo "")
    
    if [[ "$redirect_target" == "$expected_target" || "$redirect_target" == "${expected_target}/" ]]; then
        return 0
    fi
    
    echo "$redirect_target"
    return 1
}

validate_site_health() {
    local domain="$1"
    local phase="$2" # e.g., "pre-validation" or "post-validation"
    
    local http_status
    local https_status
    local redirect_target
    
    # Check HTTP (often redirects to HTTPS)
    http_status=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "http://${domain}" || echo "000")
    
    # Check HTTPS
    https_status=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "https://${domain}" || echo "000")
    
    # Check if HTTP redirects to HTTPS correctly (optional but good to capture)
    redirect_target=$(curl -s -o /dev/null -w "%{redirect_url}" -m 10 "http://${domain}" || echo "")
    
    log_info "site-validation" "phase=${phase} domain=${domain} http=${http_status} https=${https_status} redirect_target=${redirect_target}"
}
