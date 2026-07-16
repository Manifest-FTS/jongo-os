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
    
    # Try Traefik router rules (Host(`domain.com`))
    # Extract domain from label traefik.http.routers.<random>.rule
    domain=$(docker inspect --format '{{ range $k, $v := .Config.Labels }}{{ if printf "%s" $k | match "^traefik\\.http\\.routers\\..*\\.rule$" }}{{ $v }}{{ end }}{{ end }}' "$container_id" | grep -oP 'Host\(`\K[^`]+' | head -n 1)
    
    if [[ -z "$domain" ]]; then
        # Fallback to coolify.fqdn label
        domain=$(docker inspect --format '{{ index .Config.Labels "coolify.fqdn" }}' "$container_id")
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
    
    # Run wp-cli securely as www-data or appropriate user
    docker exec -u www-data "$container_id" wp "$@"
}
