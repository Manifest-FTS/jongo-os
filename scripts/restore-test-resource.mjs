#!/usr/bin/env node

/**
 * Per-app restore test: restore an app's latest Coolify database backup into an
 * isolated throwaway container and verify it comes back non-empty. Engine-aware
 * (postgresql / mariadb / mysql). Never touches the live database.
 *
 * Integrity is schema-agnostic (table count > 0) because we do not have each
 * app's DB credentials — the question answered is "does the offsite dump restore
 * cleanly into a working, non-empty database", which is the core DR check.
 *
 * Records the outcome via /api/ops/backup-restore-verification, keyed by the DB
 * resource UUID, so the "Restore verified" chip updates.
 *
 * Usage:
 *   node scripts/restore-test-resource.mjs --resource-uuid <uuid> --engine postgresql
 *
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

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || "").trim() : "";
}

const resourceUuid = argValue("--resource-uuid");
const engineRaw = (argValue("--engine") || "postgresql").toLowerCase();
const engine = engineRaw.includes("maria") ? "mariadb" : engineRaw.includes("mysql") ? "mysql" : "postgresql";

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
if (!resourceUuid) bail("--resource-uuid is required.");

// ── SSH key materialization (same handling as remediate-staging-content-sync.mjs) ──
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
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-test-key-"));
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

// ── Remote restore-test script (engine-aware, defensive about dump format) ────
function buildScript() {
  const RUUID = shQuote(resourceUuid);
  const image = engine === "postgresql" ? "postgres:16-alpine" : "mariadb:11";
  return `set -uo pipefail
RUUID=${RUUID}
ENGINE=${shQuote(engine)}

# Find the newest Coolify dump for this DB resource. Coolify stores dumps under
# /data/coolify/backups/databases/<team>/<name>-<uuid>/<file>.
DUMP=$(ls -t /data/coolify/backups/databases/*/*"$RUUID"*/* 2>/dev/null | head -1)
if [ -z "$DUMP" ]; then echo "RESULT=fail_no_dump"; exit 0; fi
echo "DUMP=$DUMP"
echo "DUMP_SIZE=$(stat -Lc %s "$DUMP" 2>/dev/null || echo 0)"

# Is it inside the offsite (B2) snapshot?
if [ -f /root/.config/restic/b2-credentials.env ]; then
  set -a; . /root/.config/restic/b2-credentials.env; set +a
  export AWS_ACCESS_KEY_ID="\${B2_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="\${B2_APPLICATION_KEY:-}"
  REPO="s3:\${B2_ENDPOINT}/\${B2_BUCKET}"
  if /usr/bin/restic -r "$REPO" ls latest 2>/dev/null | grep -qF "$(basename "$DUMP")"; then
    echo "OFFSITE_PRESENT=yes"; else echo "OFFSITE_PRESENT=no"; fi
else
  echo "OFFSITE_PRESENT=unknown_no_creds"
fi

# Decompress helper: cat or zcat depending on gzip magic.
reader() { if [ "$(head -c2 "$1" | od -An -tx1 | tr -d ' \\n')" = "1f8b" ]; then zcat "$1"; else cat "$1"; fi; }

PROBE=dr-probe-$$
docker rm -f "$PROBE" >/dev/null 2>&1 || true
START=$(date +%s)

if [ "$ENGINE" = "postgresql" ]; then
  docker run -d --name "$PROBE" -e POSTGRES_PASSWORD=dr -e POSTGRES_DB=drdb ${shQuote(image)} >/dev/null
  for i in $(seq 1 30); do docker exec "$PROBE" pg_isready -q && break; sleep 1; done
  # Coolify pg dumps may be custom-format (pg_restore) or plain SQL (psql). Try both.
  if reader "$DUMP" | docker exec -i "$PROBE" pg_restore --no-owner --no-acl -U postgres -d drdb >/dev/null 2>/tmp/$PROBE.err; then
    echo "RESTORE=ok"
  elif reader "$DUMP" | docker exec -i "$PROBE" psql -q -U postgres -d drdb >/dev/null 2>>/tmp/$PROBE.err; then
    echo "RESTORE=ok_plain"
  else
    echo "RESTORE=failed"
  fi
  TABLES=$(docker exec "$PROBE" psql -U postgres -d drdb -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)
else
  docker run -d --name "$PROBE" -e MARIADB_ROOT_PASSWORD=dr -e MARIADB_DATABASE=drdb ${shQuote(image)} >/dev/null
  for i in $(seq 1 40); do docker exec "$PROBE" mariadb -uroot -pdr -e "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
  if reader "$DUMP" | docker exec -i "$PROBE" mariadb -uroot -pdr drdb >/dev/null 2>/tmp/$PROBE.err; then
    echo "RESTORE=ok"
  else
    echo "RESTORE=failed"
  fi
  TABLES=$(docker exec "$PROBE" mariadb -uroot -pdr -N -B -e "SELECT count(*) FROM information_schema.tables WHERE table_schema='drdb'" 2>/dev/null || echo 0)
fi

END=$(date +%s)
echo "RESTORE_SECONDS=$(( END - START ))"
echo "TABLES=$TABLES"
docker rm -f "$PROBE" >/dev/null 2>&1 || true
rm -f /tmp/$PROBE.err
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
  console.log(`[restore-test] host=${sshHost} resource=${resourceUuid} engine=${engine}`);
  const r = runSshScript(buildScript());
  if (r.stderr.trim()) console.error(r.stderr.trim());
  console.log(r.stdout.trim());
  const k = parseKV(r.stdout);

  const tables = Number(k.TABLES || 0);
  const restoreClean = k.RESTORE === "ok" || k.RESTORE === "ok_plain";
  const pass = restoreClean && tables >= 1;

  const summary = {
    checkedAt: new Date().toISOString(),
    resourceUuid,
    engine,
    dumpFound: k.RESULT !== "fail_no_dump",
    offsitePresent: k.OFFSITE_PRESENT ?? "unknown",
    restore: k.RESTORE ?? "unknown",
    restoreSeconds: k.RESTORE_SECONDS ? Number(k.RESTORE_SECONDS) : null,
    tables,
    pass
  };
  console.log(`RESTORE_TEST_RESULT=${JSON.stringify(summary)}`);

  // Record so the "Restore verified" chip reflects reality.
  const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const opsToken = firstEnvValue(["BACKUP_RECONCILE_TOKEN", "OWNERSHIP_SYNC_TOKEN"]);
  if (appBaseUrl && opsToken) {
    try {
      const res = await fetch(`${appBaseUrl}/api/ops/backup-restore-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsToken}` },
        body: JSON.stringify({
          resourceUuid,
          result: pass ? "pass" : "fail",
          verifiedAt: summary.checkedAt,
          restoreSeconds: summary.restoreSeconds,
          offsitePresent: summary.offsitePresent,
          rowsMatch: null,
          rows: { tables, engine }
        })
      });
      console.log(`recorded verification -> ${res.status}`);
    } catch (error) {
      console.error(`WARN: failed to record verification: ${error instanceof Error ? error.message : "unknown"}`);
    }
  } else {
    console.log("skip recording: APP_BASE_URL / ops token not set");
  }

  console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(pass ? 0 : 1);
} finally {
  if (cleanupKeyDir) {
    try { fs.rmSync(cleanupKeyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
