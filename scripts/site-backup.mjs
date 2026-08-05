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

/**
 * Paths never worth capturing, whatever the stack.
 *
 * Mirrors BACKUP_EXCLUDES in apps/web/src/lib/backup-stack.ts, which carries
 * the rationale and the tests. Duplicated rather than imported for the same
 * reason as parseForgotten below: this script runs standalone under plain node
 * with no bundler and no path aliases.
 *
 * Applied as one superset because excludes must be chosen before restic runs,
 * while stack detection only completes afterwards. Safe because every entry is
 * regenerable build or cache output.
 */
const BACKUP_EXCLUDES = [
  "**/wp-content/cache",
  "**/wp-content/*cache*/**",
  "**/wp-content/upgrade",
  "**/node_modules/.cache",
  "**/.next/cache",
  "**/.nuxt/cache",
  "**/.turbo",
  "**/.parcel-cache",
  "**/.vite",
  "**/tmp/cache",
  "**/*.log"
];
// Joined on one line for the same reason as resticLabelFlags: a blank line
// inside a backslash-continued command ends it early.
const resticExcludeFlags = BACKUP_EXCLUDES.map((pattern) => `--exclude ${shQuote(pattern)}`).join(" ");

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

# Dump a MySQL/MariaDB database.
#
# --routines --triggers --events: stored code is part of the data. Without them
# a "complete" backup silently omits every trigger and stored procedure, which
# nobody notices until a restore produces a database that no longer works.
# They need extra privileges, so a bare flag set is tried second: a dump missing
# stored code beats no dump at all.
#
# --default-character-set=utf8mb4: the client default is utf8mb3, which mangles
# 4-byte characters (emoji, many CJK glyphs) on the way out of the database.
#
# Password via MYSQL_PWD rather than -p"$p": the command line of a docker exec
# is visible in the container's process list. It also fixes the empty-password
# case, where -p with no value makes the client prompt and the dump just hangs.
mysql_dump_to() {
  local c="$1" u="$2" p="$3" d="$4" out="$5"
  local base="--single-transaction --quick --default-character-set=utf8mb4"
  local full="$base --routines --triggers --events"
  local bin flags
  for bin in mariadb-dump mysqldump; do
    for flags in "$full" "$base"; do
      if docker exec -e MYSQL_PWD="$p" "$c" sh -lc "$bin $flags -u$u $d" > "$out" 2>/dev/null && [ -s "$out" ]; then
        return 0
      fi
    done
  done
  rm -f "$out"
  return 1
}

# Resolve MySQL/MariaDB credentials for a database container.
#
# Emits "user<TAB>password<TAB>database". Coolify does not always set a root
# password on a WordPress stack's database, in which case the only working
# credentials live on the WordPress container. site-restore.mjs resolves
# credentials the same way — when the two disagree, backups succeed and
# restores silently do nothing.
mysql_creds_for() {
  local c="$1" wp="$2"
  local u=root p d
  p=$(read_env "$c" MARIADB_ROOT_PASSWORD); [ -n "$p" ] || p=$(read_env "$c" MYSQL_ROOT_PASSWORD)
  d=$(read_env "$c" MARIADB_DATABASE); [ -n "$d" ] || d=$(read_env "$c" MYSQL_DATABASE)
  if [ -z "$p" ] && [ -n "$wp" ]; then
    u=$(read_env "$wp" WORDPRESS_DB_USER)
    p=$(read_env "$wp" WORDPRESS_DB_PASSWORD)
    d=$(read_env "$wp" WORDPRESS_DB_NAME)
  fi
  [ -n "$u" ] || u=root
  [ -n "$d" ] || d=wordpress
  printf '%s\\t%s\\t%s\\n' "$u" "$p" "$d"
}

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
# App (non-database) containers, kept so stack detection has something to probe
# after the dumps are done.
APP_CONTAINERS=""

# ── Pass 1: classify containers, collect volumes and database targets ──
while IFS= read -r c; do
  [ -n "$c" ] || continue
  IMG=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)
  NI="$c $IMG"
  case "$c" in wordpress-*) WP_CONTAINER="$c";; esac

  if echo "$NI" | grep -qiE 'postgres|mariadb|mysql|percona'; then
    echo "$c" >> "$DB_LIST"
  else
    APP_CONTAINERS="$APP_CONTAINERS $c"
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
      | grep -oiE '^[A-Z0-9_]*(DATABASE|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|DB)[A-Z0-9_]*_(URL|URI|HOST|HOSTNAME)=.*' \\
      | grep -viE '^REDIS' \\
      | sed -E 's#^[^=]+=##; s#^[a-zA-Z+]+://[^@]*@##; s#^[a-zA-Z+]+://##; s#[:/?].*##' | sort -u)
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
    # --clean --if-exists is what makes this dump RESTORABLE. Plain pg_dump
    # emits no DROP statements, so replaying it into a database that already
    # has tables fails on every object; psql without ON_ERROR_STOP shrugs those
    # off and exits 0, so the restore reports success having changed nothing.
    # --no-owner --no-acl so the dump also replays into a target whose roles
    # differ, which is what restoring into a staging clone does.
    if docker exec -e PGPASSWORD="$PGP" "$c" sh -lc "pg_dump --clean --if-exists --no-owner --no-acl -U $PGU -d $PGDB" > "$DUMP" 2>/dev/null && [ -s "$DUMP" ]; then
      echo "$DUMP" >> "$PATHS_FILE"; DBCOUNT=$((DBCOUNT+1))
    else rm -f "$DUMP"; fi
  else
    CREDS=$(mysql_creds_for "$c" "$WP_CONTAINER")
    RU=$(printf '%s' "$CREDS" | cut -f1)
    RP=$(printf '%s' "$CREDS" | cut -f2)
    MDB=$(printf '%s' "$CREDS" | cut -f3)
    if mysql_dump_to "$c" "$RU" "$RP" "$MDB" "$DUMP"; then
      echo "$DUMP" >> "$PATHS_FILE"; DBCOUNT=$((DBCOUNT+1)); WP_DB="$c"
    fi
  fi
done < "$DB_LIST"
rm -f "$DB_LIST"

sort -u "$PATHS_FILE" -o "$PATHS_FILE"
[ -s "$PATHS_FILE" ] || { echo "RESULT=fail_nothing_to_backup"; rm -f "$PATHS_FILE"; exit 1; }
echo "VOLCOUNT=$VOLCOUNT"
echo "DBCOUNT=$DBCOUNT"

# How much was actually captured, as opposed to how many things were found.
# A dump of an empty database is a valid, complete, ~600-byte file: without
# this the run reports "1 database" and success, and the customer is told they
# have a restore point that holds nothing.
TABLES=0
for f in "$STAGE"/db-*.sql; do
  [ -f "$f" ] || continue
  n=$(grep -c '^CREATE TABLE' "$f" 2>/dev/null || echo 0)
  TABLES=$((TABLES + n))
done
FILECOUNT=$(wc -l < "$PATHS_FILE" | tr -d ' ')
echo "DB_TABLES=$TABLES"
echo "CAPTURED_PATHS=$FILECOUNT"

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

# ── Stack markers ──
# Raw findings only. What they MEAN is decided by lib/backup-stack.ts on the
# server, where the rule can be unit tested, rather than in bash on a host whose
# tooling we do not control.
NODE_FRAMEWORK=""
APP_NAME=""
APP_VERSION=""
for ac in $APP_CONTAINERS; do
  [ -n "$ac" ] || continue
  for root in /app /usr/src/app /srv/app /var/www/html; do
    PKG=$(docker exec "$ac" sh -lc "cat $root/package.json" 2>/dev/null) || continue
    [ -n "$PKG" ] || continue
    # Matched as dependency KEYS. A substring search for "next" would classify
    # any app whose description or a transitive package name mentions it.
    if printf '%s' "$PKG" | grep -qE '"next"[[:space:]]*:'; then NODE_FRAMEWORK=next
    elif printf '%s' "$PKG" | grep -qE '"nuxt3?"[[:space:]]*:'; then NODE_FRAMEWORK=nuxt
    else NODE_FRAMEWORK=node
    fi
    APP_NAME=$(printf '%s' "$PKG" | grep -m1 -E '"name"[[:space:]]*:' | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\\1/')
    APP_VERSION=$(printf '%s' "$PKG" | grep -m1 -E '"version"[[:space:]]*:' | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\\1/')
    break
  done
  [ -n "$NODE_FRAMEWORK" ] && break
done
[ -n "$NODE_FRAMEWORK" ] && echo "NODE_FRAMEWORK=$NODE_FRAMEWORK"
[ -n "$APP_NAME" ] && echo "APP_NAME=$APP_NAME"
[ -n "$APP_VERSION" ] && echo "APP_VERSION=$APP_VERSION"
# base64 because the list is multi-line and the protocol here is one KEY=VALUE
# per line. Container names are what let the server recognise a stack whose
# in-container probe failed.
echo "CONTAINERS_B64=$(printf '%s' "$CONTAINERS" | base64 | tr -d '\\n')"

# ── One restic snapshot to B2: all volumes + all dumps, tagged with backup id ──
[ -f /root/.config/restic/b2-credentials.env ] || { echo "RESULT=fail_no_b2_creds"; rm -f "$PATHS_FILE"; exit 1; }
set -a; . /root/.config/restic/b2-credentials.env; set +a
export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"

# Total on-disk size of everything going into the snapshot (approximate).
# Fed NUL-separated rather than as arguments: an unquoted $(cat …) splits paths
# containing spaces into separate arguments, and a site with many volumes can
# overflow the argument list entirely.
SIZE_BYTES=$(tr '\\n' '\\0' < "$PATHS_FILE" | du -scb --files0-from=- 2>/dev/null | tail -1 | cut -f1)
echo "SIZE_BYTES=\${SIZE_BYTES:-0}"

OUT=$(/usr/bin/restic -r "$REPO" backup ${resticLabelFlags} \\
  --tag jongo-backup \\
  --tag "site=$RUUID" \\
  --tag "backup=$BID" \\
  ${resticExcludeFlags} \\
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
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" 2>/dev/null)
# Retention that quietly stops working is a bill nobody reads until it is large.
# forget fails on repo lock contention, which is exactly what concurrent backups
# produce, so the failure has to leave a trace rather than vanish into || true.
FORGET_STATUS=$?
[ "$FORGET_STATUS" -eq 0 ] || echo "FORGET_FAILED=$FORGET_STATUS"

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

/** Container names, sent base64 because the KEY=VALUE protocol is line-based. */
function decodeContainers(encoded) {
  const value = String(encoded || "").trim();
  if (!value) return [];
  try {
    return Buffer.from(value, "base64").toString("utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

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
    // Fallback only. The server classifies from stackMarkers below using
    // lib/backup-stack.ts; this crude rule stays so an older server that does
    // not read markers still records something sensible.
    resourceType: k.WP_VERSION ? "wordpress" : (num(k.DBCOUNT) && !num(k.VOLCOUNT) ? "database" : "service"),
    // Raw findings for server-side stack detection. Deliberately not classified
    // here: the rule belongs somewhere it can be tested.
    stackMarkers: {
      containers: decodeContainers(k.CONTAINERS_B64),
      wpVersion: k.WP_VERSION || null,
      posts: num(k.POSTS),
      pages: num(k.PAGES),
      plugins: num(k.PLUGINS),
      comments: num(k.COMMENTS),
      nodeFramework: k.NODE_FRAMEWORK || null,
      appName: k.APP_NAME || null,
      appVersion: k.APP_VERSION || null,
      volumeCount: num(k.VOLCOUNT),
      databaseCount: num(k.DBCOUNT),
      databaseTables: num(k.DB_TABLES)
    },
    // Snapshots retention just removed; their catalogue rows must stop
    // advertising a restore that would fail. Parsed from restic's JSON rather
    // than its human output, which prints KEPT snapshots in the same shape.
    forgottenSnapshotIds: parseForgotten(k.FORGET_JSON_B64),
    volumeCount: num(k.VOLCOUNT),
    databaseCount: num(k.DBCOUNT),
    databaseTables: num(k.DB_TABLES),
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
