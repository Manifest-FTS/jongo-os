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
// How many tables the backup recorded capturing. Used only to catch the
// unambiguous failure — the databases coming back empty when the backup held
// data — because an exact match is not guaranteed (views, stored code) and a
// false "restore failed" on a restore that worked is its own kind of damage.
const expectTables = Number(argValue("--expect-tables")) || 0;

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

read_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | awk -F= -v k="$2" '$1==k{print substr($0,index($0,"=")+1)}' | tail -n 1; }
engine_of() { local i; i=$(docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null); if echo "$1 $i" | grep -qiE 'postgres'; then echo postgres; else echo mysql; fi; }
# Resolve MySQL/MariaDB credentials for a database container. Emits
# "user<TAB>password<TAB>database".
#
# MUST stay identical to mysql_creds_for in scripts/site-backup.mjs. Coolify
# does not always set a root password on a WordPress stack's database, and the
# only working credentials then live on the WordPress container. This side
# checked root only, so for those stacks the backup succeeded while both the
# safety snapshot and the restore silently produced nothing — the exact case
# where the safety net is supposed to catch you.
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

dump_one() { # container engine -> stdout dump (used for the safety snapshot)
  local c="$1" e="$2"
  if [ "$e" = postgres ]; then
    local u p d; u=$(read_env "$c" POSTGRES_USER); [ -n "$u" ] || u=postgres; p=$(read_env "$c" POSTGRES_PASSWORD); d=$(read_env "$c" POSTGRES_DB); [ -n "$d" ] || d="$u"
    # Same --clean --if-exists as the backup path: a safety snapshot that cannot
    # be replayed over the restored state is not a rollback.
    docker exec -e PGPASSWORD="$p" "$c" sh -lc "pg_dump --clean --if-exists --no-owner --no-acl -U $u -d $d" 2>/dev/null
  else
    local creds u p d
    creds=$(mysql_creds_for "$c" "$WP_CONTAINER")
    u=$(printf '%s' "$creds" | cut -f1); p=$(printf '%s' "$creds" | cut -f2); d=$(printf '%s' "$creds" | cut -f3)
    docker exec -e MYSQL_PWD="$p" "$c" sh -lc "mariadb-dump --single-transaction --quick --default-character-set=utf8mb4 --routines --triggers -u$u $d" 2>/dev/null \\
      || docker exec -e MYSQL_PWD="$p" "$c" sh -lc "mysqldump --single-transaction --quick --default-character-set=utf8mb4 -u$u $d" 2>/dev/null
  fi
}

# Whole-segment match: services are <app>-<uuid> but applications are
# <uuid>-<deployment-ts>, so anchoring only at the end missed applications.
CONTAINERS=$(docker ps -a --format '{{.Names}}' | grep -E "(^|-)$RUUID($|-)" || true)
[ -n "$CONTAINERS" ] || { echo "RESULT=fail_no_containers"; exit 1; }

# Resolved before anything calls dump_one, which needs it for the credential
# fallback. set -u is on, so it must exist even when there is no WordPress here.
WP_CONTAINER=$(echo "$CONTAINERS" | grep -m1 '^wordpress-' || true)

[ -f /root/.config/restic/b2-credentials.env ] || { echo "RESULT=fail_no_b2_creds"; exit 1; }
set -a; . /root/.config/restic/b2-credentials.env; set +a
export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"

# ── 1. SAFETY SNAPSHOT of current state (volumes + db dumps), so this is reversible ──
STAGE="/var/backups/jongo/$RUUID"; rm -rf "$STAGE"; mkdir -p "$STAGE"
SAFE_PATHS=$(mktemp)
APP_CONTAINERS=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  IMG=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null); NI="$c $IMG"
  if echo "$NI" | grep -qiE 'postgres|mariadb|mysql|percona'; then
    E=$(engine_of "$c"); D="$STAGE/db-$c.sql"; dump_one "$c" "$E" > "$D" 2>/dev/null
    [ -s "$D" ] && echo "$D" >> "$SAFE_PATHS" || rm -f "$D"
  else
    APP_CONTAINERS="$APP_CONTAINERS $c"
    while IFS= read -r src; do
      [ -n "$src" ] && [ -d "$src" ] && echo "$src" >> "$SAFE_PATHS"
    done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Source}}{{end}}{{end}}' "$c" 2>/dev/null)
  fi
done <<< "$CONTAINERS"
if [ -s "$SAFE_PATHS" ]; then
  SAFE_OUT=$(/usr/bin/restic -r "$REPO" backup --tag jongo-pre-restore --tag "site=$RUUID" --files-from "$SAFE_PATHS" 2>&1)
  SAFE_SNAP=$(echo "$SAFE_OUT" | grep -oE 'snapshot [0-9a-f]{8,} saved' | grep -oE '[0-9a-f]{8,}' | tail -1)
fi
rm -f "$SAFE_PATHS"; rm -rf "$STAGE"
[ -n "\${SAFE_SNAP:-}" ] || { echo "RESULT=fail_safety_snapshot"; exit 1; }
echo "SAFETY_SNAPSHOT=$SAFE_SNAP"

# ── 2. Restore target snapshot to a staging dir; verify before touching live data ──
# Staged under /var/backups rather than /tmp: /tmp is tmpfs on many hosts, so a
# large site was being restored into RAM and took the box down with it. Sitting
# on the same filesystem as /var/lib/docker/volumes also keeps the copy local.
TARGET="/var/backups/jongo/restore-$RUUID-$$"
rm -rf "$TARGET"; mkdir -p "$TARGET"
/usr/bin/restic -r "$REPO" restore "$SNAP" --target "$TARGET" >/dev/null 2>&1 || { echo "RESULT=fail_restic_restore"; rm -rf "$TARGET"; exit 1; }
# The snapshot must contain at least one volume dir or a db dump.
STAGED_VOLS=$(find "$TARGET/var/lib/docker/volumes" -maxdepth 2 -type d -name _data 2>/dev/null || true)
# Search the whole staged backups tree, not one uuid dir: snapshots exist in
# three generations — legacy db.sql, db-<container>.sql under the uuid dir, and
# db-<container>.sql under a readable slug dir. Missing the legacy name meant
# older snapshots silently restored files but not the database.
STAGED_DUMPS=$(find "$TARGET/var/backups/jongo" -name 'db*.sql' 2>/dev/null || true)
[ -n "$STAGED_VOLS" ] || [ -n "$STAGED_DUMPS" ] || { echo "RESULT=fail_empty_snapshot"; rm -rf "$TARGET"; exit 1; }
echo "STAGED_OK=1"

# ── 3. Restore file volumes (stop the app containers that own them first) ──
for ac in $APP_CONTAINERS; do docker stop "$ac" >/dev/null 2>&1 || true; done
VOLS_RESTORED=0
if [ -n "$STAGED_VOLS" ]; then
  while IFS= read -r staged; do
    [ -n "$staged" ] || continue
    live="\${staged#$TARGET}"                       # strip the staging prefix -> live path
    # Everything below this line deletes. "live" is derived by string-stripping,
    # so a prefix that fails to match would point the delete somewhere real —
    # at worst "/". Refuse anything that is not a docker volume data directory.
    case "$live" in
      /var/lib/docker/volumes/*/_data) ;;
      *) echo "SKIPPED_UNSAFE_PATH=$live"; continue ;;
    esac
    [ -d "$live" ] || { mkdir -p "$live"; }
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete "$staged/" "$live/" && VOLS_RESTORED=$((VOLS_RESTORED+1))
    else
      find "$live" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
      cp -a "$staged/." "$live/" && VOLS_RESTORED=$((VOLS_RESTORED+1))
    fi
  done <<< "$STAGED_VOLS"
fi
echo "FILES_RESTORED=$VOLS_RESTORED"

# ── 4. Restore each database dump into its container (mapped by filename) ──
DBS_RESTORED=0
# Counted from the live databases AFTER the replay, not from the dump. This is
# the check that would have caught the silent no-op restore described above:
# the command exiting 0 is not evidence that anything landed.
TABLES_AFTER=0
if [ -n "$STAGED_DUMPS" ]; then
  while IFS= read -r dump; do
    [ -s "$dump" ] || continue
    base=$(basename "$dump" .sql)
    if [ "$base" = "db" ]; then
      # Legacy snapshot: filename carries no container, so use this resource's
      # only database container.
      cont=$(docker ps -a --format '{{.Names}}' | grep -E "^(mariadb|mysql|postgresql|postgres)-$RUUID\$" | head -1)
    else
      cont=$(echo "$base" | sed 's/^db-//')
    fi
    [ -n "$cont" ] || continue
    docker ps -a --format '{{.Names}}' | grep -qx "$cont" || continue
    docker start "$cont" >/dev/null 2>&1 || true
    E=$(engine_of "$cont")
    if [ "$E" = postgres ]; then
      U=$(read_env "$cont" POSTGRES_USER); [ -n "$U" ] || U=postgres; P=$(read_env "$cont" POSTGRES_PASSWORD); D=$(read_env "$cont" POSTGRES_DB); [ -n "$D" ] || D="$U"
      # ON_ERROR_STOP=1 is the whole point. psql's default is to report an error
      # and carry on, so replaying a dump into a database that already has these
      # tables logged one failure per object and still exited 0 — a restore that
      # changed nothing and reported success. --single-transaction then makes it
      # all-or-nothing, so a failure leaves the database as it was rather than
      # half-dropped.
      docker exec -i -e PGPASSWORD="$P" "$cont" sh -lc "psql -v ON_ERROR_STOP=1 --single-transaction -U $U -d $D" < "$dump" >/dev/null 2>&1 && DBS_RESTORED=$((DBS_RESTORED+1))
      n=$(docker exec -e PGPASSWORD="$P" "$cont" sh -lc "psql -tAc \\"SELECT count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')\\" -U $U -d $D" 2>/dev/null | tr -dc '0-9')
      TABLES_AFTER=$((TABLES_AFTER + \${n:-0}))
    else
      CREDS=$(mysql_creds_for "$cont" "$WP_CONTAINER")
      U=$(printf '%s' "$CREDS" | cut -f1); P=$(printf '%s' "$CREDS" | cut -f2); D=$(printf '%s' "$CREDS" | cut -f3)
      { docker exec -i -e MYSQL_PWD="$P" "$cont" sh -lc "mariadb -u$U $D" < "$dump" >/dev/null 2>&1 || docker exec -i -e MYSQL_PWD="$P" "$cont" sh -lc "mysql -u$U $D" < "$dump" >/dev/null 2>&1; } && DBS_RESTORED=$((DBS_RESTORED+1))
      n=$(docker exec -e MYSQL_PWD="$P" "$cont" sh -lc "mariadb -N -B -u$U -e \\"SELECT COUNT(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema='$D'\\"" 2>/dev/null | tr -dc '0-9')
      TABLES_AFTER=$((TABLES_AFTER + \${n:-0}))
    fi
  done <<< "$STAGED_DUMPS"
fi
echo "DB_RESTORED=$DBS_RESTORED"
echo "DB_TABLES_AFTER=$TABLES_AFTER"

# ── 5. Restart app containers ──
for ac in $APP_CONTAINERS; do docker start "$ac" >/dev/null 2>&1 || true; done
rm -rf "$TARGET"
echo "RESULT=ok"
`;
}

/**
 * Judge whether the restore actually put the data back.
 *
 * Mirrors apps/web/src/lib/restore-outcome.ts, which carries the full rationale
 * and the unit tests. Duplicated rather than imported because this script runs
 * standalone under plain node with no bundler and no path aliases — the same
 * arrangement as parseForgotten in scripts/site-backup.mjs.
 */
function describeRestoreOutcome({ result, volumesRestored, databasesRestored, tablesAfter, expectedTables }) {
  const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0; };
  const volumes = count(volumesRestored);
  const databases = count(databasesRestored);
  const expected = count(expectedTables);
  const after = tablesAfter === null || tablesAfter === undefined || tablesAfter === ""
    ? null
    : (Number.isFinite(Number(tablesAfter)) ? Math.trunc(Number(tablesAfter)) : null);

  if (String(result ?? "").trim() !== "ok") {
    return {
      ok: false,
      reason: "script_failed",
      message: "The restore did not complete. The site was left as it was and the safety snapshot is unused."
    };
  }
  if (volumes === 0 && databases === 0) {
    return {
      ok: false,
      reason: "nothing_applied",
      message: "The restore ran but put nothing back — no files and no database were applied."
    };
  }
  if (databases > 0 && expected > 0 && after === 0) {
    return {
      ok: false,
      reason: "databases_empty",
      message:
        "The restore reported applying the database, but the database is empty afterwards. The site has NOT been rolled back — use the safety snapshot before making further changes."
    };
  }
  return { ok: true, reason: "restored", message: "" };
}

function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split(/\r?\n/)) {
    // Digits included so a key like DB_TABLES_AFTER2 could never be dropped —
    // the same omission was already a live bug in scripts/site-backup.mjs.
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
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

  const filesRestored = Number(k.FILES_RESTORED || 0);
  const dbsRestored = Number(k.DB_RESTORED || 0);
  const tablesAfter = k.DB_TABLES_AFTER === undefined ? null : Number(k.DB_TABLES_AFTER);
  const outcome = describeRestoreOutcome({
    result: k.RESULT,
    volumesRestored: filesRestored,
    databasesRestored: dbsRestored,
    tablesAfter,
    expectedTables: expectTables
  });
  const ok = outcome.ok;
  const summary = {
    backupId: backupId || null,
    resourceUuid,
    snapshotId,
    volumesRestored: filesRestored,
    databasesRestored: dbsRestored,
    tablesAfter,
    expectedTables: expectTables || null,
    outcome: outcome.reason,
    safetySnapshot: k.SAFETY_SNAPSHOT || null,
    result: k.RESULT || "unknown"
  };
  if (k.SKIPPED_UNSAFE_PATH) {
    console.error(`WARN: refused to restore into an unexpected path: ${k.SKIPPED_UNSAFE_PATH}`);
  }
  if (!ok) {
    console.error(`RESTORE NOT OK (${outcome.reason}): ${outcome.message}`);
  }
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
          // The rule's own message, not the raw RESULT code: "databases_empty"
          // tells the operator nothing, and this is the one failure where what
          // they do next (roll back from the safety snapshot) actually matters.
          error: ok ? null : (outcome.message || k.RESULT || "unknown failure"),
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
