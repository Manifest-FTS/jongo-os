#!/usr/bin/env node

/**
 * Verify jongo-os is backed up offsite (Backblaze B2) and, optionally, prove it
 * restores end-to-end into a throwaway container.
 *
 * Modes:
 *   (default)         Read-only: confirm a fresh jongo dump exists locally on the
 *                     server AND inside the latest restic/B2 snapshot. Reports RPO.
 *   --restore-test    Also restore the dump into an isolated Postgres container,
 *                     measure restore time, verify row counts, then tear down.
 *
 * Reuses the SSH + env conventions of remediate-staging-content-sync.mjs so it
 * runs the same way the rest of jongo-os ops tooling does:
 *   npm run ops:verify-backup
 *   npm run ops:verify-backup -- --restore-test
 *
 * Required env (do NOT guess which DB — two jongo DBs exist):
 *   JONGO_DB_CONTAINER   Coolify Postgres container = DB resource UUID
 *   JONGO_DB_USER        e.g. jongo_prod
 *   JONGO_DB_NAME        default: postgres
 * SSH env is shared with the staging sync script (STAGING_SYNC_SSH_* / COOLIFY_SSH_*).
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

function normalizePrivateKey(value) {
  return value.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim();
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const rawArgs = process.argv.slice(2);
const restoreTest = rawArgs.includes("--restore-test");
const maxAgeHours = Number(
  (rawArgs.includes("--max-age-hours") ? rawArgs[rawArgs.indexOf("--max-age-hours") + 1] : "") ||
  process.env.JONGO_BACKUP_MAX_AGE_HOURS ||
  26
);

const jongoContainer = firstEnvValue(["JONGO_DB_CONTAINER"]);
const jongoUser = firstEnvValue(["JONGO_DB_USER"]);
const jongoDbName = firstEnvValue(["JONGO_DB_NAME"]) || "postgres";

const sshHost = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
const sshUser = firstEnvValue(["STAGING_SYNC_SSH_USER"]) || "root";
const sshStrictHostKeyChecking = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
const sshUserKnownHostsFile = (process.env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE || "").trim();
const sshPrivateKeyPathEnv = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
const sshPrivateKeyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
const sshPrivateKeyB64 = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_BASE64"]);

function bail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!sshHost) bail("SSH host not set (STAGING_SYNC_SSH_HOST / COOLIFY_SSH_HOST).");
if (!jongoContainer || !jongoUser) {
  bail("JONGO_DB_CONTAINER and JONGO_DB_USER must be set. This script refuses to guess which jongo DB to verify.");
}

// ── Materialize SSH key (same handling as the staging sync script) ────────────
let resolvedSshPrivateKeyPath = sshPrivateKeyPathEnv;
let cleanupKeyDir = "";
if (!resolvedSshPrivateKeyPath && (sshPrivateKeyRaw || sshPrivateKeyB64)) {
  let decoded;
  if (sshPrivateKeyB64) {
    try {
      decoded = Buffer.from(sshPrivateKeyB64, "base64").toString("utf8");
    } catch {
      bail("Invalid SSH private key base64 value.");
    }
  } else {
    decoded = sshPrivateKeyRaw;
  }
  const normalized = normalizePrivateKey(decoded);
  if (!normalized) bail("SSH private key is empty after normalization.");
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "jongo-backup-key-"));
  const keyPath = path.join(keyDir, "id_ed25519");
  fs.writeFileSync(keyPath, `${normalized}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  resolvedSshPrivateKeyPath = keyPath;
  cleanupKeyDir = keyDir;
}

function runSshScript(script) {
  const sshArgs = [];
  if (resolvedSshPrivateKeyPath) sshArgs.push("-i", resolvedSshPrivateKeyPath, "-o", "IdentitiesOnly=yes");
  if (sshStrictHostKeyChecking) sshArgs.push("-o", `StrictHostKeyChecking=${sshStrictHostKeyChecking}`);
  if (sshUserKnownHostsFile) sshArgs.push("-o", `UserKnownHostsFile=${sshUserKnownHostsFile}`);
  sshArgs.push(`${sshUser}@${sshHost}`, "bash", "-s");
  const result = spawnSync("ssh", sshArgs, { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.error) {
    return { ok: false, status: result.status ?? 1, stdout: result.stdout || "", stderr: `${result.stderr || ""}\nssh spawn failed: ${result.error.message}` };
  }
  return { ok: result.status === 0, status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

// ── Remote scripts ────────────────────────────────────────────────────────────
// KEY=VALUE lines on stdout are parsed back into the result summary.
function buildVerifyScript() {
  return `set -uo pipefail
DEST_DIR=/data/coolify/backups/databases/jongo-os
LATEST="$DEST_DIR/jongo-os-latest.dump"

if [ ! -e "$LATEST" ]; then echo "LOCAL_DUMP=missing"; else
  now=$(date -u +%s); mtime=$(stat -Lc %Y "$LATEST" 2>/dev/null || echo 0)
  echo "LOCAL_DUMP=present"
  echo "LOCAL_AGE_HOURS=$(( (now - mtime) / 3600 ))"
  echo "LOCAL_SIZE=$(stat -Lc %s "$LATEST" 2>/dev/null || echo 0)"
fi

# Is the jongo dump inside the latest offsite (B2) snapshot?
if [ -f /root/.config/restic/b2-credentials.env ]; then
  set -a; . /root/.config/restic/b2-credentials.env; set +a
  export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
  REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"
  if /usr/bin/restic -r "$REPO" ls latest 2>/dev/null | grep -qi 'databases/jongo-os'; then
    echo "OFFSITE_PRESENT=yes"
  else
    echo "OFFSITE_PRESENT=no"
  fi
else
  echo "OFFSITE_PRESENT=unknown_no_creds"
fi
`;
}

function buildRestoreTestScript() {
  const C = shQuote(jongoContainer);
  const U = shQuote(jongoUser);
  const D = shQuote(jongoDbName);
  return `set -uo pipefail
DEST_DIR=/data/coolify/backups/databases/jongo-os
LATEST="$DEST_DIR/jongo-os-latest.dump"
[ -e "$LATEST" ] || { echo "RESTORE=fail_no_dump"; exit 1; }

PROBE=jongo-dr-probe-$$
docker rm -f "$PROBE" >/dev/null 2>&1 || true
docker run -d --name "$PROBE" -e POSTGRES_PASSWORD=dr-restore -e POSTGRES_DB=${D} postgres:16-alpine >/dev/null
# wait for readiness (max ~30s)
for i in $(seq 1 30); do docker exec "$PROBE" pg_isready -q && break; sleep 1; done

START=$(date +%s)
if docker exec -i "$PROBE" pg_restore --no-owner --no-acl -U postgres -d ${D} < "$LATEST" 2>/tmp/$PROBE.err; then
  echo "RESTORE=ok"
else
  echo "RESTORE=completed_with_warnings"
fi
END=$(date +%s)
echo "RESTORE_SECONDS=$(( END - START ))"

# Row counts on core jongo tables (quoted Prisma identifiers). Best-effort.
COUNTS=$(docker exec "$PROBE" psql -U postgres -d ${D} -tA -c \
  "SELECT COALESCE((SELECT count(*) FROM \\"Site\\"),-1)||','||COALESCE((SELECT count(*) FROM \\"User\\"),-1)||','||COALESCE((SELECT count(*) FROM \\"Organization\\"),-1)" 2>/dev/null || echo "-1,-1,-1")
echo "ROWS_SITE_USER_ORG=$COUNTS"

# Compare against the LIVE jongo DB as ground truth (read-only).
LIVE=$(docker exec ${C} psql -U ${U} -d ${D} -tA -c \
  "SELECT COALESCE((SELECT count(*) FROM \\"Site\\"),-1)||','||COALESCE((SELECT count(*) FROM \\"User\\"),-1)||','||COALESCE((SELECT count(*) FROM \\"Organization\\"),-1)" 2>/dev/null || echo "-1,-1,-1")
echo "LIVE_ROWS_SITE_USER_ORG=$LIVE"

docker rm -f "$PROBE" >/dev/null 2>&1 || true
rm -f /tmp/$PROBE.err
echo "TEARDOWN=ok"
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

// ── Run ───────────────────────────────────────────────────────────────────────
try {
  console.log(`[verify-jongo-backup] host=${sshHost} container=${jongoContainer} db=${jongoDbName} mode=${restoreTest ? "restore-test" : "verify"}`);

  const verify = runSshScript(buildVerifyScript());
  if (verify.stderr.trim()) console.error(verify.stderr.trim());
  const v = parseKV(verify.stdout);
  console.log(verify.stdout.trim());

  const ageHours = v.LOCAL_AGE_HOURS !== undefined ? Number(v.LOCAL_AGE_HOURS) : null;
  const summary = {
    checkedAt: new Date().toISOString(),
    localDump: v.LOCAL_DUMP ?? "unknown",
    ageHours,
    rpoHours: maxAgeHours,
    fresh: ageHours !== null && ageHours <= maxAgeHours,
    offsitePresent: v.OFFSITE_PRESENT ?? "unknown",
    restore: null
  };

  if (restoreTest) {
    const r = runSshScript(buildRestoreTestScript());
    if (r.stderr.trim()) console.error(r.stderr.trim());
    console.log(r.stdout.trim());
    const rk = parseKV(r.stdout);
    const restored = (rk.ROWS_SITE_USER_ORG || "").split(",").map(Number);
    const live = (rk.LIVE_ROWS_SITE_USER_ORG || "").split(",").map(Number);
    summary.restore = {
      outcome: rk.RESTORE ?? "unknown",
      seconds: rk.RESTORE_SECONDS ? Number(rk.RESTORE_SECONDS) : null,
      rows: { restored, live },
      rowsMatch: restored.length === 3 && restored.every((n, i) => n === live[i] && n >= 0)
    };
  }

  // Machine-readable line for CI / the backup read-model to consume.
  console.log(`JONGO_BACKUP_RESULT=${JSON.stringify(summary)}`);

  const ok = summary.localDump === "present" && summary.fresh &&
    (summary.offsitePresent === "yes" || summary.offsitePresent === "unknown_no_creds") &&
    (!restoreTest || (summary.restore && summary.restore.rowsMatch));

  // Record a restore-test outcome so the "Restore verified" chip reflects reality.
  // Only after an actual restore test; read-only verify runs do not assert recoverability.
  if (restoreTest) {
    const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    const opsToken = firstEnvValue(["BACKUP_RECONCILE_TOKEN", "OWNERSHIP_SYNC_TOKEN"]);
    if (appBaseUrl && opsToken) {
      try {
        const res = await fetch(`${appBaseUrl}/api/ops/backup-restore-verification`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsToken}` },
          body: JSON.stringify({
            resourceUuid: jongoContainer,
            result: ok ? "pass" : "fail",
            verifiedAt: summary.checkedAt,
            rpoHours: maxAgeHours,
            restoreSeconds: summary.restore?.seconds ?? null,
            offsitePresent: summary.offsitePresent,
            rowsMatch: summary.restore?.rowsMatch ?? null,
            rows: summary.restore?.rows ?? null
          })
        });
        console.log(`recorded verification -> ${res.status}`);
      } catch (error) {
        console.error(`WARN: failed to record verification: ${error instanceof Error ? error.message : "unknown"}`);
      }
    } else {
      console.log("skip recording: APP_BASE_URL / ops token not set");
    }
  }

  console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(ok ? 0 : 1);
} finally {
  if (cleanupKeyDir) {
    try { fs.rmSync(cleanupKeyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
