#!/usr/bin/env bash
# logging.sh
# Structured logging library for Coolify WordPress Auto-Ops

set -Eeuo pipefail

# Ensure SERVICE_UUID is available for logs, otherwise default to "unknown"
SERVICE_UUID="${SERVICE_UUID:-unknown}"

log_message() {
    local level="$1"
    shift
    local operation="$1"
    shift
    local details="$*"
    
    local timestamp
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    
    echo "${timestamp} ${level} service=${SERVICE_UUID} operation=${operation} ${details}"
}

log_info() {
    log_message "INFO" "$@"
}

log_error() {
    log_message "ERROR" "$@" >&2
}
