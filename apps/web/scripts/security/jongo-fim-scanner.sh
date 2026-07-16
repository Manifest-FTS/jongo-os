#!/bin/bash
# jongo-fim-scanner.sh
# Executes a File Integrity Monitoring (FIM) scan by comparing against a trusted baseline

SITE_ID=""
ENV="production"
TARGET_DIR="/var/www/html"
BASELINE_FILE="/var/jongo/fim-baseline-${SITE_ID}.txt"
ACTION="scan" # 'scan' or 'update-baseline'

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --site-id) SITE_ID="$2"; shift ;;
        --env) ENV="$2"; shift ;;
        --target-dir) TARGET_DIR="$2"; shift ;;
        --baseline-file) BASELINE_FILE="$2"; shift ;;
        --update-baseline) ACTION="update-baseline" ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

if [[ "$ACTION" == "update-baseline" ]]; then
    echo "Updating FIM baseline..."
    mkdir -p "$(dirname "$BASELINE_FILE")"
    find "$TARGET_DIR" -type f -exec sha256sum {} + > "$BASELINE_FILE"
    echo "Baseline updated at $BASELINE_FILE"
    exit 0
fi

if [[ -z "$SITE_ID" || -z "$JONGO_OS_API_URL" || -z "$SCANNER_HMAC_SECRET" ]]; then
    echo "Missing required environment variables or arguments for scanning."
    exit 1
fi

START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_TS=$(date +%s%3N)

if [[ ! -f "$BASELINE_FILE" ]]; then
    echo "Baseline file not found. Run with --update-baseline first."
    exit 1
fi

# Compare current hashes with baseline using sha256sum --quiet --check
# This outputs lines like: "/path/to/file: FAILED" for modified
# It does NOT detect new files, so we also need to check for untracked files
MODIFIED_FILES=$(sha256sum --quiet -c "$BASELINE_FILE" 2>/dev/null | awk -F': ' '{print $1}')

# Check for new files (files in TARGET_DIR not in BASELINE_FILE)
# We extract paths from baseline (columns 2..end of sha256sum output)
awk '{$1=""; print substr($0,2)}' "$BASELINE_FILE" | sort > /tmp/baseline_paths.txt
find "$TARGET_DIR" -type f | sort > /tmp/current_paths.txt
NEW_FILES=$(comm -13 /tmp/baseline_paths.txt /tmp/current_paths.txt)

END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
END_TS=$(date +%s%3N)

FINDINGS_JSON="[]"

# Combine MODIFIED and NEW into JSON array
ALL_FINDINGS=$(echo -e "${MODIFIED_FILES}\n${NEW_FILES}" | sed '/^$/d')

if [[ -n "$ALL_FINDINGS" ]]; then
    FINDINGS_JSON=$(echo "$ALL_FINDINGS" | awk '
        BEGIN { printf "[" }
        {
            if (NR > 1) printf ","
            printf "{\"path\":\"%s\", \"signature\":\"FIM.HashMismatch\", \"severity\":\"MEDIUM\", \"actionTaken\":\"LOGGED\"}", $0
        }
        END { printf "]" }
    ')
fi

FILES_SCANNED=$(cat /tmp/current_paths.txt | wc -l | tr -d ' ')

# Construct JSON Payload
JSON_PAYLOAD=$(cat <<EOF
{
  "resourceId": "$SITE_ID",
  "resourceType": "site",
  "environment": "$ENV",
  "scanner": "fim-sha256",
  "scanType": "integrity",
  "startTime": "$START_TIME",
  "endTime": "$END_TIME",
  "filesScanned": $FILES_SCANNED,
  "findings": $FINDINGS_JSON,
  "status": "COMPLETED",
  "timestamp": $(date +%s%3N)
}
EOF
)

# Generate HMAC SHA256 Signature
SIGNATURE=$(echo -n "$JSON_PAYLOAD" | openssl dgst -sha256 -hmac "$SCANNER_HMAC_SECRET" -binary | xxd -p -c 256)

# Dispatch to Jongo OS
curl -s -X POST "$JONGO_OS_API_URL/api/internal/v1/security/scan-report" \
     -H "Content-Type: application/json" \
     -H "X-Scanner-Signature: $SIGNATURE" \
     -d "$JSON_PAYLOAD"

echo "FIM Scan complete and reported."
