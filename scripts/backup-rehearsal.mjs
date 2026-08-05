#!/usr/bin/env node

/**
 * Rehearse a backup: pull its restic snapshot out of Backblaze B2, replay every
 * database dump inside it into a THROWAWAY container, and check the result
 * holds tables.
 *
 * NON-DESTRUCTIVE. It never touches a live container, volume or database — the
 * dumps are replayed into freshly created probe containers that are destroyed
 * afterwards. That is what makes it safe to run unattended against customer
 * backups, and why the reconciler can schedule it.
 *
 * This is the only check that exercises the artifact the Restore button
 * actually uses. The pre-existing scripts/restore-test-resource.mjs verifies
 * COOLIFY's dumps under /data/coolify/backups/databases, which is a different
 * file produced by a different system.
 *
 * The replay flags below are deliberately identical to those in
 * scripts/site-restore.mjs. A rehearsal that replayed differently from the real
 * restore would prove nothing about the real restore.
 *
 * Usage:
 *   node scripts/backup-rehearsal.mjs --snapshot-id <restic-snap> --resource-uuid <uuid> [--backup-id <uuid>]
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

const snapshotId = argValue("--snapshot-id");
const resourceUuid = argValue("--resource-uuid");
const backupId = argValue("--backup-id");

const sshHost = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
const sshUser = firstEnvValue(["STAGING_SYNC_SSH_USER"]) || "root";
const sshStrict = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
const sshKnownHosts = (process.env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE || "").trim();
const sshKeyPathEnv = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
const sshKeyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
const sshKeyB64 = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_BASE64"]);

// Fallback probe images. The major version is normally taken from the dump
// header instead — replaying a PostgreSQL 17 dump into a 16 server fails on
// syntax the older server does not know, which would report a perfectly good
// backup as unrestorable.
const PG_FALLBACK_MAJOR = (process.env.JONGO_REHEARSAL_PG_MAJOR || "16").trim() || "16";
const MYSQL_IMAGE = (process.env.JONGO_REHEARSAL_MYSQL_IMAGE || "mariadb:11").trim() || "mariadb:11";

function bail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
if (!sshHost) bail("SSH host not set (STAGING_SYNC_SSH_HOST / COOLIFY_SSH_HOST).");
if (!snapshotId) bail("--snapshot-id is required.");
if (!resourceUuid) bail("--resource-uuid is required.");

let sshKeyPath = sshKeyPathEnv;
let cleanupDir = "";
if (!sshKeyPath && (sshKeyRaw || sshKeyB64)) {
  const decoded = sshKeyB64 ? Buffer.from(sshKeyB64, "base64").toString("utf8") : sshKeyRaw;
  const normalized = normalizePrivateKey(decoded);
  if (!normalized) bail("SSH private key empty after normalization.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-rehearsal-key-"));
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
SNAP=${shQuote(snapshotId)}
RUUID=${shQuote(resourceUuid)}

[ -f /root/.config/restic/b2-credentials.env ] || { echo "RESULT=fail_no_b2_creds"; exit 1; }
set -a; . /root/.config/restic/b2-credentials.env; set +a
export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"

# Under /var/backups rather than /tmp, which is tmpfs on many hosts.
TARGET="/var/backups/jongo/rehearsal-$RUUID-$$"
PROBES=""
# Probe containers must never outlive the run, however it ends: a leaked
# database container on the production host is worse than a failed rehearsal.
cleanup() {
  for p in $PROBES; do docker rm -f "$p" >/dev/null 2>&1 || true; done
  rm -rf "$TARGET"
}
trap cleanup EXIT INT TERM

rm -rf "$TARGET"; mkdir -p "$TARGET"

# --include so only the dump directory is pulled back. Restoring the file
# volumes too would drag gigabytes of uploads out of B2 to prove nothing about
# them, on every rehearsal, at egress cost.
if ! /usr/bin/restic -r "$REPO" restore "$SNAP" --target "$TARGET" --include /var/backups/jongo >/dev/null 2>&1; then
  echo "SNAPSHOT_RESTORED=0"
  echo "RESULT=fail_restic_restore"
  exit 0
fi
echo "SNAPSHOT_RESTORED=1"

DUMPS=$(find "$TARGET/var/backups/jongo" -name 'db*.sql' 2>/dev/null || true)
DUMPS_FOUND=0
DUMPS_REPLAYED=0
TABLES_AFTER=0

if [ -n "$DUMPS" ]; then
  N=0
  while IFS= read -r dump; do
    [ -s "$dump" ] || continue
    DUMPS_FOUND=$((DUMPS_FOUND+1))
    N=$((N+1))
    PROBE="jongo-rehearsal-$$-$N"
    PROBES="$PROBES $PROBE"
    docker rm -f "$PROBE" >/dev/null 2>&1 || true

    # Engine from the dump's own header rather than the filename: the container
    # the dump came from may no longer exist, which is exactly the situation a
    # disaster-recovery rehearsal is meant to cover.
    if head -c 4096 "$dump" | grep -qi 'PostgreSQL database dump'; then
      # Match the source major version. A dump from a newer server replayed into
      # an older one fails on syntax it does not know, which would report a good
      # backup as broken.
      MAJOR=$(head -c 4096 "$dump" | grep -oiE 'Dumped from database version [0-9]+' | grep -oE '[0-9]+$' | head -1)
      [ -n "$MAJOR" ] || MAJOR=${shQuote(PG_FALLBACK_MAJOR)}
      IMAGE="postgres:$MAJOR-alpine"
      docker run -d --name "$PROBE" -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=rehearsal "$IMAGE" >/dev/null 2>&1 || { echo "PROBE_START_FAILED=$IMAGE"; continue; }
      READY=0
      for i in $(seq 1 40); do
        if docker exec "$PROBE" pg_isready -q >/dev/null 2>&1; then READY=1; break; fi
        sleep 1
      done
      [ "$READY" = 1 ] || { echo "PROBE_NOT_READY=$PROBE"; continue; }
      # Identical flags to scripts/site-restore.mjs. A rehearsal that replayed
      # differently from the real restore would prove nothing about it.
      if docker exec -i -e PGPASSWORD=rehearsal "$PROBE" sh -lc "psql -v ON_ERROR_STOP=1 --single-transaction -U postgres -d rehearsal" < "$dump" >/dev/null 2>&1; then
        DUMPS_REPLAYED=$((DUMPS_REPLAYED+1))
      fi
      n=$(docker exec -e PGPASSWORD=rehearsal "$PROBE" sh -lc "psql -tAc \\"SELECT count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')\\" -U postgres -d rehearsal" 2>/dev/null | tr -dc '0-9')
      TABLES_AFTER=$((TABLES_AFTER + \${n:-0}))
    else
      IMAGE=${shQuote(MYSQL_IMAGE)}
      docker run -d --name "$PROBE" -e MARIADB_ROOT_PASSWORD=rehearsal -e MARIADB_DATABASE=rehearsal "$IMAGE" >/dev/null 2>&1 || { echo "PROBE_START_FAILED=$IMAGE"; continue; }
      READY=0
      for i in $(seq 1 60); do
        if docker exec -e MYSQL_PWD=rehearsal "$PROBE" sh -lc "mariadb -uroot -e 'SELECT 1'" >/dev/null 2>&1; then READY=1; break; fi
        sleep 1
      done
      [ "$READY" = 1 ] || { echo "PROBE_NOT_READY=$PROBE"; continue; }
      if docker exec -i -e MYSQL_PWD=rehearsal "$PROBE" sh -lc "mariadb -uroot rehearsal" < "$dump" >/dev/null 2>&1; then
        DUMPS_REPLAYED=$((DUMPS_REPLAYED+1))
      fi
      n=$(docker exec -e MYSQL_PWD=rehearsal "$PROBE" sh -lc "mariadb -N -B -uroot -e \\"SELECT COUNT(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema='rehearsal'\\"" 2>/dev/null | tr -dc '0-9')
      TABLES_AFTER=$((TABLES_AFTER + \${n:-0}))
    fi

    docker rm -f "$PROBE" >/dev/null 2>&1 || true
  done <<< "$DUMPS"
fi

echo "DUMPS_FOUND=$DUMPS_FOUND"
echo "DUMPS_REPLAYED=$DUMPS_REPLAYED"
echo "TABLES_AFTER=$TABLES_AFTER"
echo "RESULT=ok"
`;
}

/**
 * Did the rehearsal prove the backup restorable?
 *
 * Mirrors describeRehearsalOutcome in apps/web/src/lib/backup-rehearsal.ts,
 * which carries the full rationale and the unit tests. Duplicated rather than
 * imported because this script runs standalone under plain node with no bundler
 * and no path aliases — the same arrangement as parseForgotten in
 * scripts/site-backup.mjs.
 */
function describeRehearsalOutcome({ snapshotRestored, dumpsFound, dumpsReplayed, tablesAfter }) {
  const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0; };
  if (!snapshotRestored) {
    return {
      pass: false,
      reason: "snapshot_unreadable",
      message:
        "The snapshot could not be read back from offsite storage, so this backup could not be restored if it were needed."
    };
  }
  if (count(dumpsFound) === 0) {
    return {
      pass: true,
      reason: "no_dumps",
      message: "The snapshot read back cleanly. It holds no database dump, so there was nothing further to replay."
    };
  }
  if (count(dumpsReplayed) < count(dumpsFound)) {
    return {
      pass: false,
      reason: "replay_failed",
      message: `Only ${count(dumpsReplayed)} of ${count(dumpsFound)} database dumps in this backup could be replayed. It would not restore cleanly.`
    };
  }
  if (count(tablesAfter) === 0) {
    return {
      pass: false,
      reason: "restored_empty",
      message:
        "The database dumps replayed without error but produced no tables. This backup would restore an empty database."
    };
  }
  return { pass: true, reason: "verified", message: "" };
}

function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const startedAt = Date.now();
try {
  console.log(`[backup-rehearsal] host=${sshHost} resource=${resourceUuid} snapshot=${snapshotId}`);
  const r = runSsh(buildScript());
  if (r.stderr.trim()) console.error(r.stderr.trim());
  console.log(r.stdout.trim());
  const k = parseKV(r.stdout);

  const outcome = describeRehearsalOutcome({
    snapshotRestored: k.SNAPSHOT_RESTORED === "1",
    dumpsFound: Number(k.DUMPS_FOUND || 0),
    dumpsReplayed: Number(k.DUMPS_REPLAYED || 0),
    tablesAfter: Number(k.TABLES_AFTER || 0)
  });

  const summary = {
    checkedAt: new Date().toISOString(),
    resourceUuid,
    backupId: backupId || null,
    snapshotId,
    snapshotRestored: k.SNAPSHOT_RESTORED === "1",
    dumpsFound: Number(k.DUMPS_FOUND || 0),
    dumpsReplayed: Number(k.DUMPS_REPLAYED || 0),
    tablesAfter: Number(k.TABLES_AFTER || 0),
    seconds: Math.round((Date.now() - startedAt) / 1000),
    pass: outcome.pass,
    reason: outcome.reason
  };
  console.log(`BACKUP_REHEARSAL_RESULT=${JSON.stringify(summary)}`);
  if (!outcome.pass) console.error(`REHEARSAL FAILED (${outcome.reason}): ${outcome.message}`);

  const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const opsToken = firstEnvValue(["BACKUP_RECONCILE_TOKEN", "OWNERSHIP_SYNC_TOKEN"]);
  if (appBaseUrl && opsToken) {
    try {
      const res = await fetch(`${appBaseUrl}/api/ops/backup-restore-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsToken}` },
        body: JSON.stringify({
          resourceUuid,
          result: outcome.pass ? "pass" : "fail",
          verifiedAt: summary.checkedAt,
          restoreSeconds: summary.seconds,
          // The snapshot came out of B2, so reading it back IS the offsite check.
          offsitePresent: summary.snapshotRestored ? "yes" : "no",
          rowsMatch: null,
          rows: {
            source: "jongo_restic_snapshot",
            backupId: summary.backupId,
            snapshotId: summary.snapshotId,
            dumpsFound: summary.dumpsFound,
            dumpsReplayed: summary.dumpsReplayed,
            tables: summary.tablesAfter
          },
          detail: outcome.message || `Rehearsed snapshot ${snapshotId}: ${summary.tablesAfter} tables restored.`
        })
      });
      console.log(`recorded rehearsal -> ${res.status}`);
    } catch (e) {
      console.error(`WARN: failed to record rehearsal: ${e instanceof Error ? e.message : "unknown"}`);
    }
  } else {
    console.log("skip recording: APP_BASE_URL / ops token not set");
  }

  console.log(outcome.pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(outcome.pass ? 0 : 1);
} finally {
  if (cleanupDir) { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
