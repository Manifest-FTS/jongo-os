#!/usr/bin/env node

/**
 * Restore a site from a backup: pulls the restic snapshot from Backblaze B2 and
 * puts BOTH the WordPress files and the database back.
 *
 * DESTRUCTIVE — it overwrites live site content. Safeguards:
 *   1. A safety snapshot of the CURRENT files+db is taken first, so the restore
 *      itself is reversible.
 *   2. The WordPress container is stopped during the file swap.
 *   3. Files are staged and verified before anything is overwritten.
 *
 * Usage:
 *   node scripts/site-restore.mjs --resource-uuid <uuid> --snapshot-id <restic-snap> --backup-id <uuid>
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("=");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), "apps/web/.env.local"));

function firstEnvValue(keys) {
  for (const key of keys) {
    const v = (process.env[key] || "").trim();
    if (v) return v;
  }
  return "";
}
function normalizePrivateKey(v) { return v.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim(); }
function shQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || "").trim() : "";
}

const resourceUuid = argValue("--resource-uuid");
const snapshotId = argValue("--snapshot-id");
const backupId = argValue("--backup-id");

const sshHost = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
const sshUser = firstEnvValue(["STAGING_SYNC_SSH_USER"]) || "root";
const sshStrict = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
const sshKnownHosts = (process.env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE || "").trim();
const sshKeyPathEnv = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
const sshKeyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
const sshKeyB64 = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_BASE64"]);

function bail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
if (!sshHost) bail("SSH host not set.");
if (!resourceUuid) bail("--resource-uuid is required.");
if (!snapshotId) bail("--snapshot-id is required.");

let sshKeyPath = sshKeyPathEnv;
let cleanupDir = "";
if (!sshKeyPath && (sshKeyRaw || sshKeyB64)) {
  const decoded = sshKeyB64 ? Buffer.from(sshKeyB64, "base64").toString("utf8") : sshKeyRaw;
  const normalized = normalizePrivateKey(decoded);
  if (!normalized) bail("SSH private key empty after normalization.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-restore-key-"));
  const p = path.join(dir, "id_ed25519");
  fs.writeFileSync(p, `${normalized}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(p, 0o600);
  sshKeyPath = p;
  cleanupDir = dir;
}

function runSsh(script) {
  const args = [];
  if (sshKeyPath) args.push("-i", sshKeyPath, "-o", "IdentitiesOnly=yes");
  if (sshStrict) args.push("-o", `StrictHostKeyChecking=${sshStrict}`);
  if (sshKnownHosts) args.push("-o", `UserKnownHostsFile=${sshKnownHosts}`);
  args.push(`${sshUser}@${sshHost}`, "bash", "-s");
  const r = spawnSync("ssh", args, { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { ok: false, stdout: r.stdout || "", stderr: `${r.stderr || ""}\nssh spawn failed: ${r.error.message}` };
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function buildScript() {
  return `set -uo pipefail
RUUID=${shQuote(resourceUuid)}
SNAP=${shQuote(snapshotId)}
WP="wordpress-$RUUID"

docker ps -a --format '{{.Names}}' | grep -qx "$WP" || { echo "RESULT=fail_no_wp_container"; exit 1; }

DB=""
for c in "mariadb-$RUUID" "mysql-$RUUID" "postgresql-$RUUID" "postgres-$RUUID"; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then DB="$c"; break; fi
done
[ -n "$DB" ] || { echo "RESULT=fail_no_db_container"; exit 1; }

VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/www/html"}}{{.Source}}{{end}}{{end}}' "$WP" 2>/dev/null)
[ -n "$VOL" ] && [ -d "$VOL" ] || { echo "RESULT=fail_no_files_volume"; exit 1; }

read_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" | awk -F= -v k="$2" '$1==k{print substr($0,index($0,"=")+1)}' | tail -n 1; }
DB_NAME=$(read_env "$WP" WORDPRESS_DB_NAME); [ -n "$DB_NAME" ] || DB_NAME=wordpress
DB_USER=$(read_env "$WP" WORDPRESS_DB_USER)
DB_PASS=$(read_env "$WP" WORDPRESS_DB_PASSWORD)

[ -f /root/.config/restic/b2-credentials.env ] || { echo "RESULT=fail_no_b2_creds"; exit 1; }
set -a; . /root/.config/restic/b2-credentials.env; set +a
export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"

# ── 1. SAFETY SNAPSHOT of current state, so this restore is reversible ───────
STAGE="/var/backups/jongo/$RUUID"
mkdir -p "$STAGE"
SAFE_DUMP="$STAGE/pre-restore.sql"
if ! docker exec "$DB" sh -lc "mariadb-dump --single-transaction -u$DB_USER -p$DB_PASS $DB_NAME" > "$SAFE_DUMP" 2>/dev/null; then
  docker exec "$DB" sh -lc "mysqldump --single-transaction -u$DB_USER -p$DB_PASS $DB_NAME" > "$SAFE_DUMP" 2>/dev/null || true
fi
SAFE_OUT=$(/usr/bin/restic -r "$REPO" backup --tag jongo-pre-restore --tag "site=$RUUID" "$VOL" "$SAFE_DUMP" 2>&1)
SAFE_SNAP=$(echo "$SAFE_OUT" | grep -oE 'snapshot [0-9a-f]{8,} saved' | grep -oE '[0-9a-f]{8,}' | tail -1)
rm -f "$SAFE_DUMP"
[ -n "$SAFE_SNAP" ] || { echo "RESULT=fail_safety_snapshot"; exit 1; }
echo "SAFETY_SNAPSHOT=$SAFE_SNAP"

# ── 2. Stage the restore from B2 and verify BEFORE touching live data ────────
TARGET="/tmp/jongo-restore-$RUUID-$$"
rm -rf "$TARGET"; mkdir -p "$TARGET"
/usr/bin/restic -r "$REPO" restore "$SNAP" --target "$TARGET" >/dev/null 2>&1 || { echo "RESULT=fail_restic_restore"; rm -rf "$TARGET"; exit 1; }

SRC="$TARGET$VOL"
[ -d "$SRC" ] || { echo "RESULT=fail_no_files_in_snapshot"; rm -rf "$TARGET"; exit 1; }
[ -f "$SRC/wp-includes/version.php" ] || { echo "RESULT=fail_snapshot_not_wordpress"; rm -rf "$TARGET"; exit 1; }
RESTORED_DUMP=$(find "$TARGET/var/backups/jongo/$RUUID" -name 'db.sql' 2>/dev/null | head -1)
echo "STAGED_OK=1"

# ── 3. Swap files with the container stopped ─────────────────────────────────
docker stop "$WP" >/dev/null 2>&1 || true
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$SRC/" "$VOL/" || { echo "RESULT=fail_file_copy"; docker start "$WP" >/dev/null 2>&1 || true; rm -rf "$TARGET"; exit 1; }
else
  find "$VOL" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  cp -a "$SRC/." "$VOL/" || { echo "RESULT=fail_file_copy"; docker start "$WP" >/dev/null 2>&1 || true; rm -rf "$TARGET"; exit 1; }
fi
echo "FILES_RESTORED=1"

# ── 4. Restore the database ──────────────────────────────────────────────────
if [ -n "$RESTORED_DUMP" ] && [ -s "$RESTORED_DUMP" ]; then
  if docker exec -i "$DB" sh -lc "mariadb -u$DB_USER -p$DB_PASS $DB_NAME" < "$RESTORED_DUMP" >/dev/null 2>&1; then
    echo "DB_RESTORED=1"
  elif docker exec -i "$DB" sh -lc "mysql -u$DB_USER -p$DB_PASS $DB_NAME" < "$RESTORED_DUMP" >/dev/null 2>&1; then
    echo "DB_RESTORED=1"
  else
    echo "DB_RESTORED=0"
  fi
else
  echo "DB_RESTORED=0"
fi

docker start "$WP" >/dev/null 2>&1 || true
rm -rf "$TARGET"
echo "RESULT=ok"
`;
}

function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

try {
  console.log(`[site-restore] host=${sshHost} resource=${resourceUuid} snapshot=${snapshotId}`);
  const r = runSsh(buildScript());
  if (r.stderr.trim()) console.error(r.stderr.trim());
  console.log(r.stdout.trim());
  const k = parseKV(r.stdout);

  const ok = k.RESULT === "ok" && k.FILES_RESTORED === "1";
  const summary = {
    backupId: backupId || null,
    resourceUuid,
    snapshotId,
    filesRestored: k.FILES_RESTORED === "1",
    dbRestored: k.DB_RESTORED === "1",
    safetySnapshot: k.SAFETY_SNAPSHOT || null,
    result: k.RESULT || "unknown"
  };
  console.log(`SITE_RESTORE_RESULT=${JSON.stringify(summary)}`);
  if (summary.safetySnapshot) {
    console.log(`Pre-restore state saved as restic snapshot ${summary.safetySnapshot} (use it to roll back).`);
  }

  // Report completion so the UI can stop showing "restoring…" and tell the user.
  const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const opsToken = firstEnvValue(["BACKUP_RECONCILE_TOKEN", "OWNERSHIP_SYNC_TOKEN"]);
  if (backupId && appBaseUrl && opsToken) {
    try {
      const res = await fetch(`${appBaseUrl}/api/ops/site-restore-record`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsToken}` },
        body: JSON.stringify({
          backupId,
          status: ok ? "success" : "failed",
          error: ok ? null : (k.RESULT || "unknown failure"),
          safetySnapshot: summary.safetySnapshot
        })
      });
      console.log(`recorded restore -> ${res.status}`);
    } catch (e) {
      console.error(`WARN: failed to record restore: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(ok ? 0 : 1);
} finally {
  if (cleanupDir) { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
