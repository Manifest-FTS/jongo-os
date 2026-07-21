#!/usr/bin/env bash
# docker.sh
# Docker interaction library for Coolify WordPress Auto-Ops

set -Eeuo pipefail

# Ensure logging library is loaded
source "$(dirname "${BASH_SOURCE[0]}")/logging.sh"

discover_container() {
    local uuid="$1"
    local container_id
    
    # Try multiple label variants since we couldn't definitively inspect the server
    container_id=$(docker ps -q --filter "label=coolify.serviceId=${uuid}" | head -n 1)
    
    if [[ -z "$container_id" ]]; then
        # Fallback to older or alternative Coolify label naming schemes
        container_id=$(docker ps -q --filter "label=com.docker.compose.service=${uuid}" | head -n 1)
    fi
    
    if [[ -z "$container_id" ]]; then
        log_error "docker-discovery" "status=failed reason=container-not-found"
        return 1
    fi
    
    echo "$container_id"
}

get_coolify_domain() {
    local container_id="$1"
    local domain=""
    local labels_json=""

    # Pull labels as JSON and parse in shell so this works on docker engines
    # that do not support advanced template helpers like "match".
    labels_json=$(docker inspect --format '{{ json .Config.Labels }}' "$container_id" 2>/dev/null || echo "")

    if [[ -n "$labels_json" ]]; then
        domain=$(echo "$labels_json" \
            | grep -oE '"traefik\.http\.routers\.[^"]+\.rule":"[^"]+"' \
            | sed -E 's/.*Host\(`([^`]+)`.*/\1/' \
            | head -n 1)
    fi

    if [[ -z "$domain" ]]; then
        # Fallback to coolify.fqdn label
        domain=$(docker inspect --format '{{ index .Config.Labels "coolify.fqdn" }}' "$container_id" 2>/dev/null || true)
    fi

    if [[ -z "$domain" ]]; then
        # Fallback to caddy label format like https://example.com
        domain=$(docker inspect --format '{{ index .Config.Labels "caddy_0" }}' "$container_id" 2>/dev/null \
            | sed -E 's#https?://##; s#/.*$##' || true)
    fi
    
    if [[ -z "$domain" ]]; then
        log_error "docker-domain-discovery" "status=failed container_id=${container_id}"
        return 1
    fi
    
    # If there are multiple domains separated by commas, just take the first one as primary
    echo "$domain" | cut -d',' -f1
}

wait_for_container() {
    local container_id="$1"
    local retries=30
    local wait=2
    
    log_info "wait-for-container" "container_id=${container_id} status=starting"
    
    for i in $(seq 1 $retries); do
        local state
        state=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || echo "missing")
        
        if [[ "$state" == "running" ]]; then
            log_info "wait-for-container" "container_id=${container_id} status=ready"
            return 0
        fi
        
        sleep "$wait"
    done
    
    log_error "wait-for-container" "container_id=${container_id} status=timeout"
    return 1
}

docker_exec_wp() {
    local container_id="$1"
    shift

    # Prefer native wp binary when available.
    if docker exec -u www-data "$container_id" sh -lc 'command -v wp >/dev/null 2>&1'; then
        docker exec -u www-data "$container_id" wp --path=/var/www/html "$@"
        return $?
    fi

    # Fallback: bootstrap wp-cli.phar inside the container for official
    # wordpress images that do not include wp binary.
    docker exec "$container_id" sh -lc '
        if [ ! -f /tmp/wp-cli.phar ]; then
            if command -v curl >/dev/null 2>&1; then
                curl -fsSL -o /tmp/wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
            elif command -v wget >/dev/null 2>&1; then
                wget -qO /tmp/wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
            else
                exit 127
            fi
            chmod 755 /tmp/wp-cli.phar
        fi
    '

    docker exec -u www-data "$container_id" php /tmp/wp-cli.phar --path=/var/www/html "$@"
}
