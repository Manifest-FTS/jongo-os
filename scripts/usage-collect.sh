#!/usr/bin/env bash
# Resource usage collector — run on a Docker host over SSH (`bash -s`).
#
# READ-ONLY. It reads kernel counters and `docker inspect`; it never writes,
# restarts or execs into anything. Jongo prepends three variables:
#
#   USAGE_DISK=1       also size persistent volumes (slow-ish: ~2s; run hourly)
#   USAGE_LIVE_GAP=N   take two passes N seconds apart, for a "now" CPU reading
#
# Why kernel counters instead of `docker stats` or an agent:
#   - cgroup v2 `cpu.stat usage_usec` and /proc/<pid>/net/dev are CUMULATIVE.
#     The difference between two readings is the exact CPU time and bytes used
#     in between, however far apart the readings are. `docker stats` gives an
#     instantaneous percentage, which sampled every few minutes is a guess.
#   - Nothing to install. One batched `docker inspect` plus file reads covers
#     ~80 containers in well under a second.
#
# Output is tab-separated, one record per line, first field is the type:
#   V  <format-version>
#   P  <pass-number>                         (live mode only)
#   H  ts host ncpu memTotal memAvailable cpuBusyUsec netRx netTx diskSize diskUsed diskAvail
#   C  ts id name startedAt netMode memLimit nanoCpus coolifyType project resource env traefik cpuUsec memCurrent inactiveFile netRx netTx
#   M  containerId sourcePath                (disk mode)
#   S  bytes sourcePath                      (disk mode)
# A field that could not be read is "-". Empty is never used: bash `read` with
# a whitespace IFS collapses empty fields and shifts every later column.

set -u
export LC_ALL=C
USAGE_DISK="${USAGE_DISK:-0}"
USAGE_LIVE_GAP="${USAGE_LIVE_GAP:-0}"
TAB="$(printf '\t')"

or_dash() { if [ -n "$1" ]; then printf '%s' "$1"; else printf '%s' "-"; fi; }

# "eth0:123" and "eth0: 123" both occur in /proc/net/dev once counters are
# large enough to fill the column, so split on the colon first.
netdev_totals() {
  sed 's/:/ /' "$1" 2>/dev/null | awk -v only="$2" '
    NR > 2 && $1 != "lo" && (only == "" || $1 == only) { r += $2; t += $10 }
    END { printf "%.0f %.0f", r, t }'
}

host_line() {
  local ts ncpu mt ma tck busy iface nr nt ds du
  ts="$(date +%s)"
  ncpu="$(nproc 2>/dev/null)"
  mt="$(awk '/^MemTotal:/ { printf "%.0f", $2 * 1024 }' /proc/meminfo)"
  ma="$(awk '/^MemAvailable:/ { printf "%.0f", $2 * 1024 }' /proc/meminfo)"
  tck="$(getconf CLK_TCK 2>/dev/null)"; [ -n "$tck" ] || tck=100
  # busy = user+nice+system+irq+softirq+steal (guest is already inside user)
  busy="$(awk -v t="$tck" '/^cpu / { printf "%.0f", ($2+$3+$4+$7+$8+$9) * 1000000 / t }' /proc/stat)"
  iface="$(ip route show default 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i+1); exit } }')"
  nr="-"; nt="-"
  if [ -n "$iface" ]; then
    set -- $(netdev_totals /proc/net/dev "$iface")
    nr="${1:--}"; nt="${2:--}"
  fi
  ds="$(df -B1 --output=size / 2>/dev/null | tail -1 | tr -d ' ')"
  du="$(df -B1 --output=used / 2>/dev/null | tail -1 | tr -d ' ')"
  # avail excludes the blocks reserved for root, so used/(used+avail) is the
  # percentage df and Coolify's disk alert report.
  da="$(df -B1 --output=avail / 2>/dev/null | tail -1 | tr -d ' ')"
  printf 'H\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ts" "$(hostname)" "$(or_dash "$ncpu")" "$(or_dash "$mt")" "$(or_dash "$ma")" \
    "$(or_dash "$busy")" "$nr" "$nt" "$(or_dash "$ds")" "$(or_dash "$du")" "$(or_dash "$da")"
}

# Every label goes through `with ... else -` so an absent label prints "-".
INSPECT_FMT='{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{.State.Pid}}{{"\t"}}{{.State.StartedAt}}{{"\t"}}{{.HostConfig.NetworkMode}}{{"\t"}}{{.HostConfig.Memory}}{{"\t"}}{{.HostConfig.NanoCpus}}{{"\t"}}{{with index .Config.Labels "coolify.type"}}{{.}}{{else}}-{{end}}{{"\t"}}{{with index .Config.Labels "coolify.projectName"}}{{.}}{{else}}-{{end}}{{"\t"}}{{with index .Config.Labels "coolify.resourceName"}}{{.}}{{else}}-{{end}}{{"\t"}}{{with index .Config.Labels "coolify.environmentName"}}{{.}}{{else}}-{{end}}{{"\t"}}{{with index .Config.Labels "traefik.enable"}}{{.}}{{else}}-{{end}}'

container_pass() {
  local ids
  ids="$(docker ps -q --no-trunc 2>/dev/null)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  docker inspect -f "$INSPECT_FMT" $ids 2>/dev/null |
  while IFS="$TAB" read -r id name pid started netmode meml nano ctype proj res envn traefik; do
    [ -n "$id" ] || continue
    local ts cg cpu mem inf rx tx
    ts="$(date +%s)"
    name="${name#/}"
    cg="/sys/fs/cgroup/system.slice/docker-$id.scope"
    [ -d "$cg" ] || cg="/sys/fs/cgroup/docker/$id"
    cpu="$(awk '$1 == "usage_usec" { print $2 }' "$cg/cpu.stat" 2>/dev/null)"
    mem="$(cat "$cg/memory.current" 2>/dev/null)"
    inf="$(awk '$1 == "inactive_file" { print $2 }' "$cg/memory.stat" 2>/dev/null)"
    rx="-"; tx="-"
    # Host-networked containers would report the HOST's interface, and
    # `container:` mode shares another container's — both double-count.
    case "$netmode" in
      host|container:*) ;;
      *)
        if [ "$pid" != "0" ] && [ -r "/proc/$pid/net/dev" ]; then
          set -- $(netdev_totals "/proc/$pid/net/dev" "")
          rx="${1:--}"; tx="${2:--}"
        fi
        ;;
    esac
    printf 'C\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$ts" "$id" "$(or_dash "$name")" "$(or_dash "$started")" "$(or_dash "$netmode")" \
      "$(or_dash "$meml")" "$(or_dash "$nano")" "$ctype" "$proj" "$res" "$envn" "$traefik" \
      "$(or_dash "$cpu")" "$(or_dash "$mem")" "$(or_dash "$inf")" "$rx" "$tx"
  done
}

disk_pass() {
  local ids srcs
  ids="$(docker ps -q --no-trunc 2>/dev/null)"
  [ -n "$ids" ] || return 0
  srcs="$(mktemp)"
  # Only persistent data counts: named volumes and Coolify's bind-mount dirs.
  # Sockets, /etc files and other host paths are not the app's storage.
  # shellcheck disable=SC2086
  docker inspect -f '{{.Id}}{{range .Mounts}}{{"\t"}}{{.Source}}{{end}}' $ids 2>/dev/null |
  while IFS="$TAB" read -r -a f; do
    local cid="${f[0]:-}" i
    [ -n "$cid" ] || continue
    for ((i = 1; i < ${#f[@]}; i++)); do
      case "${f[$i]}" in
        /var/lib/docker/volumes/*|/data/coolify/*)
          printf 'M\t%s\t%s\n' "$cid" "${f[$i]}"
          printf '%s\n' "${f[$i]}" >> "$srcs"
          ;;
      esac
    done
  done
  # One du over every unique path, NUL-separated so spaces in paths survive.
  sort -u "$srcs" | tr '\n' '\0' |
    timeout 180 du -sb --files0-from=- 2>/dev/null |
    awk -F'\t' '{ printf "S\t%s\t%s\n", $1, $2 }'
  rm -f "$srcs"
}

echo "V${TAB}1"
if [ "$USAGE_LIVE_GAP" != "0" ]; then
  echo "P${TAB}1"; host_line; container_pass
  sleep "$USAGE_LIVE_GAP"
  echo "P${TAB}2"; host_line; container_pass
else
  host_line
  container_pass
  [ "$USAGE_DISK" = "1" ] && disk_pass
fi
exit 0
