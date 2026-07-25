#!/usr/bin/env node

/**
 * Create a full site backup: WordPress FILES + database dump captured into a
 * single restic snapshot in Backblaze B2, plus Flywheel-style content metadata
 * (posts / pages / plugins / comments / WP version).
 *
 * One snapshot per backup means each catalog row is independently restorable
 * offsite — see scripts/site-restore.mjs.
 *
 * Usage:
 *   node scripts/site-backup.mjs --resource-uuid <uuid> --backup-id <uuid> [--label "before upgrade"]
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
    const value = (process.env[key] || "").trim();
    if (value) return value;
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
const backupId = argValue("--backup-id");
const label = argValue("--label");
// Readable identifiers for Backblaze. Without these a snapshot shows only the
// server hostname and opaque UUIDs, so you cannot tell which site it belongs to.
const siteSlug = argValue("--site-slug");
const siteName = argValue("--site-name");
// restic --host must be a simple hostname-ish token.
const resticHost = (siteSlug || siteName || "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
// Joined into ONE line: emitting these as conditional lines inside a
// backslash-continued command yields a blank line when they are absent, which
// ends the command early and breaks the script.
// Retention policy (per site, applied after each successful backup).
const keepDaily = Number(process.env.JONGO_BACKUP_KEEP_DAILY || 7) || 7;
const keepWeekly = Number(process.env.JONGO_BACKUP_KEEP_WEEKLY || 4) || 4;
const keepMonthly = Number(process.env.JONGO_BACKUP_KEEP_MONTHLY || 6) || 6;

const resticLabelFlags = [
  resticHost ? `--host ${resticHost}` : null,
  siteSlug ? `--tag "slug=${siteSlug}"` : null,
  siteName ? `--tag ${shQuote(`name=${siteName}`)}` : null
].filter(Boolean).join(" ");

const sshHost = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
const sshUser = firstEnvValue(["STAGING_SYNC_SSH_USER"]) || "root";
const sshStrict = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
const sshKnownHosts = (process.env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE || "").trim();
const sshKeyPathEnv = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
const sshKeyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
const sshKeyB64 = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_BASE64"]);

function bail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
if (!sshHost) bail("SSH host not set (STAGING_SYNC_SSH_HOST / COOLIFY_SSH_HOST).");
if (!resourceUuid) bail("--resource-uuid is required.");
if (!backupId) bail("--backup-id is required.");

let sshKeyPath = sshKeyPathEnv;
let cleanupDir = "";
if (!sshKeyPath && (sshKeyRaw || sshKeyB64)) {
  let decoded = sshKeyB64 ? Buffer.from(sshKeyB64, "base64").toString("utf8") : sshKeyRaw;
  const normalized = normalizePrivateKey(decoded);
  if (!normalized) bail("SSH private key empty after normalization.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-backup-key-"));
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

// Emits KEY=VALUE lines. Shell vars use $VAR (no braces) so JS does not
// interpolate them; JS values are injected via ${shQuote(...)}.
function buildScript() {
  return `set -uo pipefail
RUUID=${shQuote(resourceUuid)}
BID=${shQuote(backupId)}

read_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | awk -F= -v k="$2" '$1==k{print substr($0,index($0,"=")+1)}' | tail -n 1; }

# Discover every running container for this resource. Coolify names them
# <app>-<uuid> (wordpress-, mariadb-, …) or, for a standalone database, just
# <uuid>. This replaces the WordPress-only assumption.
# Match the uuid anywhere as a whole segment: Coolify names service containers
# <app>-<uuid> (uuid last) but APPLICATION containers <uuid>-<deployment-ts>
# (uuid first). Anchoring only at the end missed every application.
CONTAINERS=$(docker ps --format '{{.Names}}' | grep -E "(^|-)$RUUID($|-)" || true)
[ -n "$CONTAINERS" ] || { echo "RESULT=fail_no_containers"; exit 1; }

STAGE=${shQuote(`/var/backups/jongo/${siteSlug || "unknown"}`)}
rm -rf "$STAGE"; mkdir -p "$STAGE"
PATHS_FILE=$(mktemp)
DB_LIST=$(mktemp)
VOLCOUNT=0
DBCOUNT=0
WP_CONTAINER=""
WP_DB=""

# ── Pass 1: classify containers, collect volumes and database targets ──
while IFS= read -r c; do
  [ -n "$c" ] || continue
  IMG=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)
  NI="$c $IMG"
  case "$c" in wordpress-*) WP_CONTAINER="$c";; esac

  if echo "$NI" | grep -qiE 'postgres|mariadb|mysql|percona'; then
    echo "$c" >> "$DB_LIST"
  else
    # Application/service container: its named (persistent) volumes.
    while IFS= read -r src; do
      [ -n "$src" ] && [ -d "$src" ] && { echo "$src" >> "$PATHS_FILE"; VOLCOUNT=$((VOLCOUNT+1)); }
    done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Source}}{{end}}{{end}}' "$c" 2>/dev/null)

    # Linked databases: an app reaches its DB on a Coolify internal hostname that
    # IS the database resource uuid, e.g. postgres://u:p@<db-uuid>:5432/db.
    # Without this, a stateless app (no volumes) would have nothing to back up
    # even though its data lives in a database next door.
    while IFS= read -r h; do
      [ -n "$h" ] || continue
      if docker ps --format '{{.Names}}' | grep -qx "$h"; then echo "$h" >> "$DB_LIST"; fi
    done < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null \
      | grep -oiE '^(DATABASE_URL|DATABASE_URI|POSTGRES_URL|MYSQL_URL|DB_URL)=.*' \
      | sed -E 's#^[^=]+=##; s#^[a-zA-Z+]+://[^@]*@##; s#[:/?].*##' | sort -u)
  fi
done <<< "$CONTAINERS"

sort -u "$DB_LIST" -o "$DB_LIST"

# ── Pass 2: dump every database we found (own or linked) ──
while IFS= read -r c; do
  [ -n "$c" ] || continue
  IMG=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)
  DUMP="$STAGE/db-$c.sql"
  if echo "$c $IMG" | grep -qiE 'postgres'; then
    PGU=$(read_env "$c" POSTGRES_USER); [ -n "$PGU" ] || PGU=postgres
    PGDB=$(read_env "$c" POSTGRES_DB); [ -n "$PGDB" ] || PGDB="$PGU"
    PGP=$(read_env "$c" POSTGRES_PASSWORD)
    if docker exec -e PGPASSWORD="$PGP" "$c" sh -lc "pg_dump -U $PGU -d $PGDB" > "$DUMP" 2>/dev/null && [ -s "$DUMP" ]; then
      echo "$DUMP" >> "$PATHS_FILE"; DBCOUNT=$((DBCOUNT+1))
    else rm -f "$DUMP"; fi
  else
    RU=root
    RP=$(read_env "$c" MARIADB_ROOT_PASSWORD); [ -n "$RP" ] || RP=$(read_env "$c" MYSQL_ROOT_PASSWORD)
    MDB=$(read_env "$c" MARIADB_DATABASE); [ -n "$MDB" ] || MDB=$(read_env "$c" MYSQL_DATABASE)
    if [ -z "$RP" ] && [ -n "$WP_CONTAINER" ]; then
      RU=$(read_env "$WP_CONTAINER" WORDPRESS_DB_USER)
      RP=$(read_env "$WP_CONTAINER" WORDPRESS_DB_PASSWORD)
      MDB=$(read_env "$WP_CONTAINER" WORDPRESS_DB_NAME)
    fi
    [ -n "$MDB" ] || MDB=wordpress
    if docker exec "$c" sh -lc "mariadb-dump --single-transaction -u$RU -p$RP $MDB" > "$DUMP" 2>/dev/null && [ -s "$DUMP" ]; then
      echo "$DUMP" >> "$PATHS_FILE"; DBCOUNT=$((DBCOUNT+1)); WP_DB="$c"
    elif docker exec "$c" sh -lc "mysqldump --single-transaction -u$RU -p$RP $MDB" > "$DUMP" 2>/dev/null && [ -s "$DUMP" ]; then
      echo "$DUMP" >> "$PATHS_FILE"; DBCOUNT=$((DBCOUNT+1)); WP_DB="$c"
    else rm -f "$DUMP"; fi
  fi
done < "$DB_LIST"
rm -f "$DB_LIST"

sort -u "$PATHS_FILE" -o "$PATHS_FILE"
[ -s "$PATHS_FILE" ] || { echo "RESULT=fail_nothing_to_backup"; rm -f "$PATHS_FILE"; exit 1; }
echo "VOLCOUNT=$VOLCOUNT"
echo "DBCOUNT=$DBCOUNT"

# ── WordPress content metadata (Flywheel-style columns) — only when present ──
if [ -n "$WP_CONTAINER" ] && [ -n "$WP_DB" ]; then
  WU=$(read_env "$WP_CONTAINER" WORDPRESS_DB_USER)
  WP_PASS=$(read_env "$WP_CONTAINER" WORDPRESS_DB_PASSWORD)
  WN=$(read_env "$WP_CONTAINER" WORDPRESS_DB_NAME); [ -n "$WN" ] || WN=wordpress
  PREFIX=$(read_env "$WP_CONTAINER" WORDPRESS_TABLE_PREFIX); [ -n "$PREFIX" ] || PREFIX=wp_
  if ! docker exec "$WP_DB" sh -lc "mariadb -u$WU -p$WP_PASS -N -B -e \\"SELECT 1 FROM \${PREFIX}posts LIMIT 1\\" $WN" >/dev/null 2>&1; then
    DETECTED=$(docker exec "$WP_DB" sh -lc "mariadb -u$WU -p$WP_PASS -N -B -e \\"SHOW TABLES LIKE '%posts'\\" $WN" 2>/dev/null | head -1 | sed 's/posts\$//')
    [ -n "$DETECTED" ] && PREFIX="$DETECTED"
  fi
  WPVER=$(docker exec "$WP_CONTAINER" sh -lc "grep -m1 '\\\$wp_version =' /var/www/html/wp-includes/version.php 2>/dev/null | sed \\"s/.*'\\([^']*\\)'.*/\\1/\\"" 2>/dev/null)
  PLUGINS=$(docker exec "$WP_CONTAINER" sh -lc 'ls -1 /var/www/html/wp-content/plugins 2>/dev/null | grep -v "^index.php$" | wc -l' 2>/dev/null || echo 0)
  q() { docker exec "$WP_DB" sh -lc "mariadb -u$WU -p$WP_PASS -N -B -e \\"$1\\" $WN" 2>/dev/null || echo ""; }
  echo "WP_VERSION=$WPVER"
  echo "PLUGINS=$PLUGINS"
  echo "POSTS=$(q "SELECT COUNT(*) FROM \${PREFIX}posts WHERE post_type='post' AND post_status='publish'")"
  echo "PAGES=$(q "SELECT COUNT(*) FROM \${PREFIX}posts WHERE post_type='page' AND post_status='publish'")"
  echo "COMMENTS=$(q "SELECT COUNT(*) FROM \${PREFIX}comments WHERE comment_approved='1'")"
fi

# ── One restic snapshot to B2: all volumes + all dumps, tagged with backup id ──
[ -f /root/.config/restic/b2-credentials.env ] || { echo "RESULT=fail_no_b2_creds"; rm -f "$PATHS_FILE"; exit 1; }
set -a; . /root/.config/restic/b2-credentials.env; set +a
export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"

# Total on-disk size of everything going into the snapshot (approximate).
SIZE_BYTES=$(du -scb $(cat "$PATHS_FILE") 2>/dev/null | tail -1 | cut -f1)
echo "SIZE_BYTES=\${SIZE_BYTES:-0}"

OUT=$(/usr/bin/restic -r "$REPO" backup ${resticLabelFlags} \\
  --tag jongo-backup \\
  --tag "site=$RUUID" \\
  --tag "backup=$BID" \\
  --exclude '**/wp-content/cache' \\
  --exclude '**/wp-content/*cache*/**' \\
  --exclude '**/wp-content/upgrade' \\
  --files-from "$PATHS_FILE" 2>&1)
rm -f "$PATHS_FILE"
echo "$OUT" | tail -5
SNAP=$(echo "$OUT" | grep -oE 'snapshot [0-9a-f]{8,} saved' | grep -oE '[0-9a-f]{8,}' | tail -1)
rm -rf "$STAGE"
[ -n "$SNAP" ] || { echo "RESULT=fail_restic"; exit 1; }
echo "SNAPSHOT=$SNAP"

# ── Retention: without this, every backup is kept forever and B2 grows without
# bound. Scoped by tag so it only ever affects THIS site's jongo backups.
# Deliberately no --prune: the nightly offsite job already prunes the repo, and
# pruning here would contend for the repo lock with concurrent backups.
KEEP_DAILY=${keepDaily}
KEEP_WEEKLY=${keepWeekly}
KEEP_MONTHLY=${keepMonthly}
# --json because restic's human output prints the KEPT snapshots in the same
# table shape as removed ones ("keep 1 snapshots:" followed by an id per line).
# Scraping that marked every brand-new snapshot as forgotten, which would flag
# each fresh backup as pruned and make it unrestorable the moment it was taken.
# --group-by host so retention is evaluated per site rather than per path set:
# the default (host,paths) starts a new group whenever a site's container set
# changes, and each group would then keep its own full policy. Grouping by tags
# would be worse still, since backup=<id> is unique per snapshot.
FORGET_JSON=$(/usr/bin/restic -r "$REPO" forget --json --group-by host \\
  --tag "site=$RUUID" \\
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" 2>/dev/null) || true

# Hand the raw JSON back for the caller to parse. Doing it here would mean
# scraping in shell on a host whose tooling we do not control, and it is exactly
# that scraping which produced the bug this replaced. base64 keeps it to one
# line so it survives the KEY=VALUE protocol.
if [ -n "$FORGET_JSON" ]; then
  echo "FORGET_JSON_B64=$(printf '%s' "$FORGET_JSON" | base64 | tr -d '\\n')"
fi

echo "RESULT=ok"
`;
}

function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split(/\r?\n/)) {
    // Digits matter: FORGET_JSON_B64 would otherwise never be captured.
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
/**
 * Extract the snapshots `restic forget` actually removed.
 *
 * Mirrors apps/web/src/lib/restic-forget.ts, which carries the full rationale
 * and the unit tests. Duplicated rather than imported because this script runs
 * standalone under plain node with no bundler and no path aliases.
 *
 * Returns nothing when the payload cannot be understood: a wrong id here marks
 * a good backup unrestorable, while a missing one is corrected by the next run.
 */
function parseForgotten(encoded) {
  const value = String(encoded || "").trim();
  if (!value) return [];
  let groups;
  try {
    groups = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(groups)) return [];
  const ids = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const removed = group.remove; // null, not [], when nothing is removed
    if (!Array.isArray(removed)) continue;
    for (const snap of removed) {
      if (!snap || typeof snap !== "object") continue;
      const id = typeof snap.short_id === "string" && snap.short_id.trim()
        ? snap.short_id.trim()
        : typeof snap.id === "string" ? snap.id.trim().slice(0, 8) : "";
      if (id) ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

try {
  console.log(`[site-backup] host=${sshHost} resource=${resourceUuid} backup=${backupId}`);
  const r = runSsh(buildScript());
  if (r.stderr.trim()) console.error(r.stderr.trim());
  console.log(r.stdout.trim());
  const k = parseKV(r.stdout);

  const ok = k.RESULT === "ok" && Boolean(k.SNAPSHOT);
  const payload = {
    backupId,
    status: ok ? "success" : "failed",
    resticSnapshotId: k.SNAPSHOT || null,
    sizeBytes: num(k.SIZE_BYTES),
    resourceType: k.WP_VERSION ? "wordpress" : (num(k.DBCOUNT) && !num(k.VOLCOUNT) ? "database" : "service"),
    // Snapshots retention just removed; their catalogue rows must stop
    // advertising a restore that would fail. Parsed from restic's JSON rather
    // than its human output, which prints KEPT snapshots in the same shape.
    forgottenSnapshotIds: parseForgotten(k.FORGET_JSON_B64),
    volumeCount: num(k.VOLCOUNT),
    databaseCount: num(k.DBCOUNT),
    posts: num(k.POSTS),
    pages: num(k.PAGES),
    plugins: num(k.PLUGINS),
    comments: num(k.COMMENTS),
    wpVersion: k.WP_VERSION || null,
    label: label || null,
    error: ok ? null : (k.RESULT || "unknown failure")
  };
  console.log(`SITE_BACKUP_RESULT=${JSON.stringify(payload)}`);

  const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const opsToken = firstEnvValue(["BACKUP_RECONCILE_TOKEN", "OWNERSHIP_SYNC_TOKEN"]);
  if (appBaseUrl && opsToken) {
    try {
      const res = await fetch(`${appBaseUrl}/api/ops/site-backup-record`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsToken}` },
        body: JSON.stringify(payload)
      });
      console.log(`recorded backup -> ${res.status}`);
    } catch (e) {
      console.error(`WARN: failed to record backup: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(ok ? 0 : 1);
} finally {
  if (cleanupDir) { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
