#!/usr/bin/env bash
# Restrict the SSH key Jongo uses to reach this server (security finding S-03).
#
# Run ON THE HOSTING SERVER as root:
#   sudo bash restrict-jongo-ssh-key.sh "<jongo public key, e.g. ssh-ed25519 AAAA... comment>"          # dry run
#   sudo bash restrict-jongo-ssh-key.sh "<jongo public key>" --apply                                     # change it
#
# What it changes, on that one key's line in /root/.ssh/authorized_keys only:
#   from="<docker subnets>,127.0.0.1,::1"   the key works only from this server itself
#                                           (the Jongo container), so a leaked copy is
#                                           useless anywhere else
#   no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty
#                                           Jongo only runs `bash -s` scripts; it never
#                                           needs tunnels or a terminal
#
# Every other key (Coolify's own included) is left exactly as it is.
# A dated backup is written next to the file; the rollback command is printed.
set -euo pipefail

KEY="${1:-}"
APPLY="${2:-}"
FILE="${AUTHORIZED_KEYS_FILE:-/root/.ssh/authorized_keys}"

if [[ -z "$KEY" ]]; then
  echo "Usage: $0 \"<jongo public key>\" [--apply]" >&2
  exit 2
fi
[[ -f "$FILE" ]] || { echo "Not found: $FILE" >&2; exit 1; }

# The base64 body identifies the key regardless of options or comment.
BODY="$(awk '{for (i=1;i<=NF;i++) if ($i ~ /^AAAA/) {print $i; exit}}' <<<"$KEY")"
[[ -n "$BODY" ]] || { echo "That doesn't look like a public key (no AAAA... part)." >&2; exit 2; }

MATCHES="$(grep -c -F -- "$BODY" "$FILE" || true)"
if [[ "$MATCHES" != "1" ]]; then
  echo "Expected exactly one line with this key in $FILE, found $MATCHES. Nothing changed." >&2
  exit 1
fi

# Where the Jongo container connects from: every Docker network on this host.
SUBNETS="$(docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9a-f.:]+/[0-9]+$' | sort -u | paste -sd, -)"
[[ -n "$SUBNETS" ]] || { echo "Couldn't read Docker network subnets. Nothing changed." >&2; exit 1; }
FROM="${SUBNETS},127.0.0.1,::1"
OPTIONS="from=\"${FROM}\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty"

CURRENT="$(grep -F -- "$BODY" "$FILE")"
# Drop any options already on the line: keep from the key type onwards.
BARE="$(sed -E 's/^.*((ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) AAAA)/\1/' <<<"$CURRENT")"
EXISTING="${CURRENT%"$BARE"}"
EXISTING="${EXISTING%" "}"
# Options this script set before are replaced; anything else (a forced
# command, for example) is never dropped silently.
if [[ -n "$EXISTING" && "$EXISTING" != from=\"* ]]; then
  echo "This key already has options this script didn't set:" >&2
  echo "  $EXISTING" >&2
  echo "Add the restrictions by hand instead: $OPTIONS" >&2
  exit 1
fi
NEW="${OPTIONS} ${BARE}"

echo "Key line now:"
echo "  ${CURRENT:0:120}..."
echo "Will become:"
echo "  ${NEW:0:200}..."
echo "Allowed sources: ${FROM}"

if [[ "$APPLY" != "--apply" ]]; then
  echo
  echo "Dry run. Re-run with --apply to make the change."
  exit 0
fi

BACKUP="${FILE}.bak-$(date +%Y%m%d%H%M%S)"
cp -p "$FILE" "$BACKUP"
TMP="$(mktemp "${FILE}.XXXX")"
awk -v body="$BODY" -v new="$NEW" 'index($0, body) { print new; next } { print }' "$FILE" > "$TMP"
chmod --reference="$FILE" "$TMP" && chown --reference="$FILE" "$TMP"
mv "$TMP" "$FILE"

echo
echo "Done. Backup: $BACKUP"
echo "Check from the Jongo container terminal that SSH still works, e.g. run a backup or a cache flush."
echo "If anything broke, roll back with:"
echo "  cp -p '$BACKUP' '$FILE'"
