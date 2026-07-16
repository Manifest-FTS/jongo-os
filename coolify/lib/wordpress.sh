#!/usr/bin/env bash
# wordpress.sh
# WP-CLI interaction library for Coolify WordPress Auto-Ops

set -Eeuo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/logging.sh"
source "$(dirname "${BASH_SOURCE[0]}")/docker.sh"

wp_check_prerequisites() {
    local container_id="$1"
    
    # Check if wp-cli exists and can be executed
    if ! docker_exec_wp "$container_id" --info &>/dev/null; then
        log_error "wp-prerequisites" "status=failed container_id=${container_id} reason=wp-cli-unavailable"
        return 1
    fi
    
    # Check if WordPress is actually installed
    if ! docker_exec_wp "$container_id" core is-installed &>/dev/null; then
        log_error "wp-prerequisites" "status=failed container_id=${container_id} reason=wp-not-installed"
        return 1
    fi
    
    return 0
}

wp_get_option() {
    local container_id="$1"
    local option_name="$2"
    
    docker_exec_wp "$container_id" option get "$option_name" 2>/dev/null || echo ""
}

wp_update_option() {
    local container_id="$1"
    local option_name="$2"
    local option_value="$3"
    
    local current_value
    current_value=$(wp_get_option "$container_id" "$option_name")
    
    if [[ "$current_value" == "$option_value" ]]; then
        log_info "wp-update-option" "option=${option_name} status=skipped reason=already-matches-desired"
        return 0
    fi
    
    if docker_exec_wp "$container_id" option update "$option_name" "$option_value"; then
        log_info "wp-update-option" "option=${option_name} old=${current_value} new=${option_value} status=success"
    else
        log_error "wp-update-option" "option=${option_name} status=failed"
        return 1
    fi
}

wp_flush_caches() {
    local container_id="$1"
    
    log_info "wp-cache-flush" "status=starting"
    
    # Core cache flush
    docker_exec_wp "$container_id" cache flush || log_error "wp-cache-flush" "type=core status=failed"
    
    # Rewrite rules flush
    docker_exec_wp "$container_id" rewrite flush || log_error "wp-cache-flush" "type=rewrite status=failed"
    
    # Check for redis plugin
    if docker_exec_wp "$container_id" plugin is-active redis-cache 2>/dev/null; then
        log_info "wp-cache-flush" "type=redis status=flushing"
        docker_exec_wp "$container_id" redis flush || log_error "wp-cache-flush" "type=redis status=failed"
    fi
    
    log_info "wp-cache-flush" "status=completed"
}
