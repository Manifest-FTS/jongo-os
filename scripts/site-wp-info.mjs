#!/usr/bin/env node

/**
 * Read a WordPress site's runtime facts: WP version, PHP version, database name
 * and table prefix.
 *
 * READ-ONLY. It runs no writes, starts nothing and changes no state — it exists
 * so the app can show what a site actually is rather than what it was when the
 * last backup ran.
 *
 * Every field is reported independently and may come back empty. A container
 * that answers some probes and not others is normal (a stock image has no
 * wp-cli, a stopped database answers nothing), and reporting a blank is honest
 * where inventing a default would not be.
 *
 * Usage: node scripts/site-wp-info.mjs --resource-uuid <uuid>
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
function shQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || "").trim() : "";
}

const resourceUuid = argValue("--resource-uuid");
const sshHost = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
const sshUser = firstEnvValue(["STAGING_SYNC_SSH_USER"]) || "root";
const sshStrict = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
const sshKeyPathEnv = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
const sshKeyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
const sshKeyB64 = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_BASE64"]);

function bail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
if (!sshHost) bail("SSH host not set.");
if (!resourceUuid) bail("--resource-uuid is required.");

let sshKeyPath = sshKeyPathEnv;
let cleanupDir = "";
if (!sshKeyPath && (sshKeyRaw || sshKeyB64)) {
  const decoded = sshKeyB64 ? Buffer.from(sshKeyB64, "base64").toString("utf8") : sshKeyRaw;
  const normalized = decoded.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim();
  if (!normalized) bail("SSH private key empty after normalization.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-info-key-"));
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
  args.push(`${sshUser}@${sshHost}`, "bash", "-s");
  const r = spawnSync("ssh", args, { input: script, encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function buildScript() {
  return `set -uo pipefail
RUUID=${shQuote(resourceUuid)}

read_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | awk -F= -v k="$2" '$1==k{print substr($0,index($0,"=")+1)}' | tail -n 1; }

CONTAINERS=$(docker ps --format '{{.Names}}' | grep -E "(^|-)$RUUID($|-)" || true)
[ -n "$CONTAINERS" ] || { echo "RESULT=fail_no_containers"; exit 1; }

WP=$(echo "$CONTAINERS" | grep -m1 '^wordpress-' || true)
[ -n "$WP" ] || { echo "RESULT=fail_no_wordpress"; exit 1; }
echo "CONTAINER=$WP"

# WordPress version from the source file, not wp-cli: the stock image has no
# wp-cli, and version.php is present in every install.
WPV=$(docker exec "$WP" sh -lc "grep -m1 '\\\\\$wp_version =' /var/www/html/wp-includes/version.php 2>/dev/null | sed \\"s/.*'\\\\([^']*\\\\)'.*/\\\\1/\\"" 2>/dev/null | tr -d '\\r')
[ -n "$WPV" ] && echo "WP_VERSION=$WPV"

PHPV=$(docker exec "$WP" sh -lc 'php -r "echo PHP_VERSION;"' 2>/dev/null | tr -d '\\r')
[ -n "$PHPV" ] && echo "PHP_VERSION=$PHPV"

DBNAME=$(read_env "$WP" WORDPRESS_DB_NAME)
[ -n "$DBNAME" ] && echo "DB_NAME=$DBNAME"

# Prefix: the declared value if set, otherwise inferred from the live schema.
PREFIX=$(read_env "$WP" WORDPRESS_TABLE_PREFIX)
if [ -z "$PREFIX" ]; then
  DB=$(echo "$CONTAINERS" | grep -m1 -E '^(mariadb|mysql)-' || true)
  if [ -n "$DB" ]; then
    WU=$(read_env "$WP" WORDPRESS_DB_USER)
    WPPASS=$(read_env "$WP" WORDPRESS_DB_PASSWORD)
    WN=\${DBNAME:-wordpress}
    DETECTED=$(docker exec -e MYSQL_PWD="$WPPASS" "$DB" sh -lc "mariadb -N -B -u$WU -e \\"SHOW TABLES LIKE '%posts'\\" $WN" 2>/dev/null | head -1 | sed 's/posts$//' | tr -d '\\r')
    [ -n "$DETECTED" ] && PREFIX="$DETECTED"
  fi
fi
[ -n "$PREFIX" ] && echo "DB_PREFIX=$PREFIX"

echo "RESULT=ok"
`;
}

function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

try {
  const r = runSsh(buildScript());
  const k = parseKV(r.stdout);
  const ok = k.RESULT === "ok";
  const payload = {
    ok,
    reason: ok ? null : (k.RESULT || "unknown"),
    container: k.CONTAINER || null,
    wpVersion: k.WP_VERSION || null,
    phpVersion: k.PHP_VERSION || null,
    databaseName: k.DB_NAME || null,
    tablePrefix: k.DB_PREFIX || null
  };
  console.log(`SITE_WP_INFO_RESULT=${JSON.stringify(payload)}`);
  process.exit(ok ? 0 : 1);
} finally {
  if (cleanupDir) { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
