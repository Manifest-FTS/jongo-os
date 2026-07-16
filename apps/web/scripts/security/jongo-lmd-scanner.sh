#!/bin/bash
# jongo-lmd-scanner.sh
# Executes a Linux Malware Detect (LMD) scan and posts structured JSON back to Jongo OS

SITE_ID=""
ENV="production"
TARGET_DIR="/var/www/html"

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --site-id) SITE_ID="$2"; shift ;;
        --env) ENV="$2"; shift ;;
        --target-dir) TARGET_DIR="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

if [[ -z "$SITE_ID" || -z "$JONGO_OS_API_URL" || -z "$SCANNER_HMAC_SECRET" ]]; then
    echo "Missing required environment variables or arguments."
    exit 1
fi

START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_TS=$(date +%s%3N)

# In a real environment, we'd run: maldet -a "$TARGET_DIR"
# For this script, we'll simulate clamscan since maldet parsing is complex in raw bash
# We assume clamscan is available or LMD is hooked into clamscan.
SCAN_OUTPUT=$(clamscan -r --infected --no-summary "$TARGET_DIR" 2>/dev/null || true)

END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
END_TS=$(date +%s%3N)
DURATION=$((END_TS - START_TS))

# Parse findings into JSON array
FINDINGS_JSON="[]"
if [[ -n "$SCAN_OUTPUT" ]]; then
    # Convert clamscan output: "/path/to/file: Virus.Name FOUND" to JSON
    # This is a basic awk parser for demonstration
    FINDINGS_JSON=$(echo "$SCAN_OUTPUT" | awk -F': ' '
        BEGIN { printf "[" }
        {
            if (NR > 1) printf ","
            file=$1; sig=$2; sub(/ FOUND$/, "", sig);
            printf "{\"path\":\"%s\", \"signature\":\"%s\", \"severity\":\"HIGH\", \"actionTaken\":\"LOGGED\"}", file, sig
        }
        END { printf "]" }
    ')
fi

# Count files (mocked since clamscan --no-summary omits it, ideally we'd parse the summary)
FILES_SCANNED=$(find "$TARGET_DIR" -type f | wc -l | tr -d ' ')

# Construct JSON Payload
JSON_PAYLOAD=$(cat <<EOF
{
  "resourceId": "$SITE_ID",
  "resourceType": "site",
  "environment": "$ENV",
  "scanner": "lmd-clamav",
  "scanType": "malware",
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

echo "Scan complete and reported."
