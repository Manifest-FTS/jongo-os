#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), "apps/web/.env.local"));

function firstEnvValue(keys) {
  for (const key of keys) {
    const value = (process.env[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function normalizePrivateKey(value) {
  return value.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim();
}

const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const sshHost = (process.env.STAGING_SYNC_SSH_HOST || process.env.COOLIFY_SSH_HOST || "").trim();
const sshUser = (process.env.STAGING_SYNC_SSH_USER || "root").trim();
const sshStrictHostKeyChecking = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
const sshUserKnownHostsFile = (process.env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE || "").trim();
const sshPrivateKeyPathEnv = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
const sshPrivateKeyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
const sshPrivateKeyB64 = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_BASE64"]);
const urlRewriteModeRaw = (process.env.STAGING_SYNC_URL_REWRITE_MODE || "strict").trim().toLowerCase();
const strictUrlRewrite = urlRewriteModeRaw !== "best-effort";
const rawArgs = process.argv.slice(2);
const apply = rawArgs.includes("--apply");
const validDirections = new Set(["production-to-staging", "staging-to-production"]);

let overrideProdServiceUuid = "";
let overrideStagingServiceUuid = "";
let overrideStagingUrl = "";
let overrideProductionUrl = "";
let overrideSiteId = "";
let direction = (process.env.STAGING_SYNC_DIRECTION || "production-to-staging").trim().toLowerCase();
const cliIds = [];

for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === "--apply") {
    continue;
  }
  if (arg === "--prod-service-uuid") {
    overrideProdServiceUuid = (rawArgs[index + 1] || "").trim();
    index += 1;
    continue;
  }
  if (arg === "--staging-service-uuid") {
    overrideStagingServiceUuid = (rawArgs[index + 1] || "").trim();
    index += 1;
    continue;
  }
  if (arg === "--staging-url") {
    overrideStagingUrl = (rawArgs[index + 1] || "").trim();
    index += 1;
    continue;
  }
  if (arg === "--production-url") {
    overrideProductionUrl = (rawArgs[index + 1] || "").trim();
    index += 1;
    continue;
  }
  if (arg === "--site-id") {
    overrideSiteId = (rawArgs[index + 1] || "").trim();
    index += 1;
    continue;
  }
  if (arg === "--direction") {
    direction = (rawArgs[index + 1] || "").trim().toLowerCase();
    index += 1;
    continue;
  }

  if (!arg.startsWith("--")) {
    cliIds.push(arg.trim());
  }
}

const envIds = (process.env.STAGING_SITE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const envOverrideProdServiceUuid = (process.env.STAGING_SYNC_PROD_SERVICE_UUID || "").trim();
const envOverrideStagingServiceUuid = (process.env.STAGING_SYNC_STAGING_SERVICE_UUID || "").trim();
const envOverrideStagingUrl = (process.env.STAGING_SYNC_STAGING_URL || "").trim();
const envOverrideProductionUrl = (process.env.STAGING_SYNC_PRODUCTION_URL || "").trim();
const envOverrideSiteId = (process.env.STAGING_SYNC_SITE_ID || "").trim();

if (!overrideProdServiceUuid) {
  overrideProdServiceUuid = envOverrideProdServiceUuid;
}
if (!overrideStagingServiceUuid) {
  overrideStagingServiceUuid = envOverrideStagingServiceUuid;
}
if (!overrideStagingUrl) {
  overrideStagingUrl = envOverrideStagingUrl;
}
if (!overrideProductionUrl) {
  overrideProductionUrl = envOverrideProductionUrl;
}
if (!overrideSiteId) {
  overrideSiteId = envOverrideSiteId;
}

if (!validDirections.has(direction)) {
  console.error(`Unsupported direction: ${direction}`);
  process.exit(1);
}

if (!token) {
  console.error("Missing OWNERSHIP_SYNC_TOKEN.");
  process.exit(1);
}

if (!sshHost) {
  console.error("Missing STAGING_SYNC_SSH_HOST (or COOLIFY_SSH_HOST).");
  process.exit(1);
}

let resolvedSshPrivateKeyPath = sshPrivateKeyPathEnv;
let sshAuthMode = "default";
if (!resolvedSshPrivateKeyPath && (sshPrivateKeyRaw || sshPrivateKeyB64)) {
  let decoded;
  if (sshPrivateKeyB64) {
    try {
      decoded = Buffer.from(sshPrivateKeyB64, "base64").toString("utf8");
    } catch {
      console.error("Invalid STAGING_SYNC_SSH_PRIVATE_KEY_B64 / COOLIFY_SSH_PRIVATE_KEY_B64 value.");
      process.exit(1);
    }
  } else {
    decoded = sshPrivateKeyRaw;
  }

  const normalized = normalizePrivateKey(decoded);
  if (!normalized) {
    console.error("SSH private key value is empty after normalization.");
    process.exit(1);
  }

  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "staging-sync-key-"));
  const keyPath = path.join(keyDir, "id_ed25519");
  fs.writeFileSync(keyPath, `${normalized}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  resolvedSshPrivateKeyPath = keyPath;
  sshAuthMode = sshPrivateKeyB64 ? "env:b64" : "env:raw";
} else if (resolvedSshPrivateKeyPath) {
  sshAuthMode = "env:path";
}

function authHeaders() {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: `Invalid JSON response: ${text.slice(0, 250)}` };
  }
}

async function discoverSiteIds() {
  const res = await fetch(`${baseUrl}/api/sites/staging-targets?scope=linked`, {
    headers: authHeaders(),
    redirect: "manual"
  });

  const body = await parseJsonResponse(res);
  if (res.status !== 200) {
    throw new Error(`Discovery failed ${res.status}: ${body?.error || "unknown error"}`);
  }

  const sites = Array.isArray(body?.sites) ? body.sites : [];
  return sites
    .map((item) => item?.recommendedId)
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

async function readStaging(siteId) {
  const res = await fetch(`${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging`, {
    headers: authHeaders(),
    redirect: "manual"
  });

  const body = await parseJsonResponse(res);
  return { status: res.status, body };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runSshScript(script) {
  const sshArgs = [];
  if (resolvedSshPrivateKeyPath) {
    sshArgs.push("-i", resolvedSshPrivateKeyPath, "-o", "IdentitiesOnly=yes");
  }
  if (sshStrictHostKeyChecking) {
    sshArgs.push("-o", `StrictHostKeyChecking=${sshStrictHostKeyChecking}`);
  }
  if (sshUserKnownHostsFile) {
    sshArgs.push("-o", `UserKnownHostsFile=${sshUserKnownHostsFile}`);
  }
  sshArgs.push(`${sshUser}@${sshHost}`, "bash", "-s");

  const result = spawnSync("ssh", sshArgs, {
    input: script,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });

  const spawnError = result.error;
  if (spawnError) {
    const details = `ssh spawn failed: ${spawnError.message}`;
    return {
      ok: false,
      status: result.status ?? 1,
      stdout: result.stdout || "",
      stderr: `${result.stderr || ""}${result.stderr ? "\n" : ""}${details}`
    };
  }

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function buildCloneScript(params) {
  const {
    prodServiceUuid,
    stagingServiceUuid,
    stagingUrl,
    productionUrl,
    strictRewrite,
    syncDirection
  } = params;

  const sourceIsProduction = syncDirection === "production-to-staging";
  const sourceWp = sourceIsProduction ? `wordpress-${prodServiceUuid}` : `wordpress-${stagingServiceUuid}`;
  const sourceDb = sourceIsProduction ? `mariadb-${prodServiceUuid}` : `mariadb-${stagingServiceUuid}`;
  const targetWp = sourceIsProduction ? `wordpress-${stagingServiceUuid}` : `wordpress-${prodServiceUuid}`;
  const targetDb = sourceIsProduction ? `mariadb-${stagingServiceUuid}` : `mariadb-${prodServiceUuid}`;
  const targetUrl = sourceIsProduction ? stagingUrl : productionUrl;

  return `set -euo pipefail
SRC_WP=${shQuote(sourceWp)}
SRC_DB=${shQuote(sourceDb)}
TARGET_WP=${shQuote(targetWp)}
TARGET_DB=${shQuote(targetDb)}
TARGET_URL=${shQuote(targetUrl)}

for name in "$SRC_WP" "$SRC_DB" "$TARGET_WP" "$TARGET_DB"; do
  docker ps --format '{{.Names}}' | grep -Fx "$name" >/dev/null || { echo "Missing container: $name"; exit 1; }
done

command -v docker >/dev/null

docker exec "$SRC_DB" sh -lc 'command -v mariadb-dump >/dev/null'
docker exec "$TARGET_DB" sh -lc 'command -v mariadb >/dev/null'

read_env() {
  local wp_container="$1"
  local key="$2"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$wp_container" | awk -F= -v k="$key" '$1==k{print substr($0,index($0,"=")+1)}' | tail -n 1
}

SRC_DB_HOST=$(read_env "$SRC_WP" WORDPRESS_DB_HOST)
SRC_DB_NAME=$(read_env "$SRC_WP" WORDPRESS_DB_NAME)
SRC_DB_USER=$(read_env "$SRC_WP" WORDPRESS_DB_USER)
SRC_DB_PASSWORD=$(read_env "$SRC_WP" WORDPRESS_DB_PASSWORD)

TARGET_DB_HOST=$(read_env "$TARGET_WP" WORDPRESS_DB_HOST)
TARGET_DB_NAME=$(read_env "$TARGET_WP" WORDPRESS_DB_NAME)
TARGET_DB_USER=$(read_env "$TARGET_WP" WORDPRESS_DB_USER)
TARGET_DB_PASSWORD=$(read_env "$TARGET_WP" WORDPRESS_DB_PASSWORD)

for required in SRC_DB_NAME SRC_DB_USER SRC_DB_PASSWORD TARGET_DB_NAME TARGET_DB_USER TARGET_DB_PASSWORD TARGET_URL; do
  value="\${!required}"
  [ -n "$value" ] || { echo "Missing DB credential: $required"; exit 1; }
done

echo "DB clone start"
docker exec "$SRC_DB" sh -lc "mariadb-dump --single-transaction -u$SRC_DB_USER -p$SRC_DB_PASSWORD $SRC_DB_NAME" | docker exec -i "$TARGET_DB" sh -lc "mariadb -u$TARGET_DB_USER -p$TARGET_DB_PASSWORD $TARGET_DB_NAME"
echo "DB clone done"

echo "Files clone start"
docker exec "$SRC_WP" sh -lc "cd /var/www/html; tar -cf - --exclude=wp-config.php .; TAR_EXIT=$?; [ $TAR_EXIT -eq 0 ] || [ $TAR_EXIT -eq 1 ]" | docker exec -i "$TARGET_WP" sh -lc "cd /var/www/html; tar -xf -"
echo "Files clone done"

UPDATED_TABLE=""
for candidate in wp_options options; do
  SQL="UPDATE \${candidate} SET option_value='\${TARGET_URL}' WHERE option_name IN ('siteurl','home');"
  if docker exec "$TARGET_DB" mariadb -u"$TARGET_DB_USER" -p"$TARGET_DB_PASSWORD" "$TARGET_DB_NAME" -e "$SQL" >/dev/null 2>&1; then
    UPDATED_TABLE="$candidate"
    break
  fi
done

if [ -n "$UPDATED_TABLE" ]; then
  echo "Updated $UPDATED_TABLE siteurl/home"
else
  echo "No options table detected for URL update"
  ${strictRewrite ? "exit 1" : "echo 'URL rewrite skipped (best-effort mode). Continuing.'"}
fi

docker restart "$STG_WP" >/dev/null
docker restart "$TARGET_WP" >/dev/null
echo "Target WP restarted"
`;
}

function buildPreflightScript(params) {
  const {
    prodServiceUuid,
    stagingServiceUuid
  } = params;

  return `set -euo pipefail
PROD_WP=wordpress-${prodServiceUuid}
PROD_DB=mariadb-${prodServiceUuid}
STG_WP=wordpress-${stagingServiceUuid}
STG_DB=mariadb-${stagingServiceUuid}
for name in "$PROD_WP" "$PROD_DB" "$STG_WP" "$STG_DB"; do
  docker ps --format '{{.Names}}' | grep -Fx "$name" >/dev/null || { echo "MISSING:$name"; exit 1; }
done

echo "FOUND:$PROD_WP"
echo "FOUND:$PROD_DB"
echo "FOUND:$STG_WP"
echo "FOUND:$STG_DB"
`;
}

async function run() {
  const overrideEnabled = Boolean(overrideProdServiceUuid && overrideStagingServiceUuid && overrideStagingUrl);
  const overrideTargetSiteId = overrideSiteId || cliIds[0] || envIds[0] || "override-target";

  const siteIds = overrideEnabled
    ? [overrideTargetSiteId]
    : cliIds.length > 0
      ? cliIds
      : envIds.length > 0
        ? envIds
        : await discoverSiteIds();

  if (siteIds.length === 0) {
    console.error("No site IDs found.");
    process.exit(1);
  }

  console.log(`Targets: ${siteIds.length}`);
  console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
  console.log(`Direction: ${direction}`);
  console.log(`SSH: ${sshUser}@${sshHost}`);
  console.log(`SSH auth mode: ${sshAuthMode}`);
  console.log(`URL rewrite mode: ${strictUrlRewrite ? "strict" : "best-effort"}`);
  if (overrideEnabled) {
    console.log("Capability override mode: enabled");
  }

  let eligible = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const siteId of siteIds) {
    let prodServiceUuid = "";
    let stagingServiceUuid = "";
    let stagingUrlRaw = "";
    let resourceKind = "unknown";
    let targetHealthy = false;

    if (overrideEnabled) {
      prodServiceUuid = overrideProdServiceUuid;
      stagingServiceUuid = overrideStagingServiceUuid;
      stagingUrlRaw = overrideStagingUrl;
      resourceKind = "service";
      targetHealthy = true;
    } else {
      const response = await readStaging(siteId);
      if (response.status !== 200) {
        skipped += 1;
        console.log(`[${siteId}] skip staging endpoint status=${response.status}`);
        continue;
      }

      const site = response.body?.site || {};
      const capability = response.body?.stagingCapability || {};

      prodServiceUuid = typeof site.coolifyServiceUuid === "string" ? site.coolifyServiceUuid.trim() : "";
      stagingServiceUuid = typeof capability.applicationUuid === "string" ? capability.applicationUuid.trim() : "";
      stagingUrlRaw = typeof capability.stagingUrl === "string" ? capability.stagingUrl.trim() : "";
      resourceKind = typeof capability.resourceKind === "string" ? capability.resourceKind : "unknown";
      targetHealthy = capability.status === "healthy";
    }

    const stagingUrl = stagingUrlRaw ? stagingUrlRaw.replace(/\/+$/, "") : "";
    const isServicePair = resourceKind === "service" && Boolean(prodServiceUuid) && Boolean(stagingServiceUuid);

    if (!isServicePair || !stagingUrl) {
      skipped += 1;
      console.log(`[${siteId}] skip incompatible target kind=${resourceKind || "unknown"} prod=${Boolean(prodServiceUuid)} stg=${Boolean(stagingServiceUuid)} url=${Boolean(stagingUrl)}`);
      continue;
    }

    eligible += 1;

    const preflight = runSshScript(buildPreflightScript({ prodServiceUuid, stagingServiceUuid }));
    if (!preflight.ok) {
      failed += 1;
      console.log(`[${siteId}] fail preflight containers not ready`);
      if (preflight.stdout.trim()) {
        console.log(preflight.stdout.trim());
      }
      if (preflight.stderr.trim()) {
        console.log(preflight.stderr.trim());
      }
      continue;
    }

    if (!apply) {
      console.log(`[${siteId}] dry-run eligible resource=service healthy=${targetHealthy} stagingUrl=${stagingUrl}`);
      continue;
    }

    const productionUrl = overrideProductionUrl;
    const clone = runSshScript(buildCloneScript({
      prodServiceUuid,
      stagingServiceUuid,
      stagingUrl,
      productionUrl,
      strictRewrite: strictUrlRewrite,
      syncDirection: direction
    }));

    if (!clone.ok) {
      failed += 1;
      console.log(`[${siteId}] fail clone status=${clone.status}`);
      if (clone.stdout.trim()) {
        console.log(clone.stdout.trim());
      }
      if (clone.stderr.trim()) {
        console.log(clone.stderr.trim());
      }
      continue;
    }

    succeeded += 1;
    console.log(`[${siteId}] ok content sync complete`);
    if (clone.stdout.trim()) {
      console.log(clone.stdout.trim());
    }
  }

  console.log(`Summary: eligible=${eligible} succeeded=${succeeded} failed=${failed} skipped=${skipped}`);

  if (apply && failed > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error("remediate-staging-content-sync failed:", error.message);
  process.exit(1);
});
