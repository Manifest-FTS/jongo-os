#!/usr/bin/env node

/**
 * Flush a WordPress site's caches.
 *
 * Replaces a button that showed "Cache flush request queued." and did nothing —
 * no request, no queue, no flush. Reporting a flush that never happened is
 * worse than a dead button: it sends someone debugging a stale page off to look
 * anywhere but the cache.
 *
 * Three places a WordPress site keeps a cache, each independently optional:
 *
 *   1. the object cache, cleared with wp-cli when the image has it (the stock
 *      `wordpress` image does not);
 *   2. page cache FILES under wp-content/cache, written by WP Super Cache,
 *      W3TC, LiteSpeed, WP Rocket and friends;
 *   3. a linked Redis used as the object cache backend.
 *
 * Each is reported as flushed / absent / failed and the caller decides what
 * that adds up to (see apps/web/src/lib/cache-flush.ts). Deliberately NOT
 * reported: PHP opcache. Resetting it needs to happen inside the running
 * PHP-FPM worker, and `php -r opcache_reset()` from a separate process does
 * nothing — claiming it as flushed would be the original bug again.
 *
 * NON-DESTRUCTIVE of content: it removes only cache artefacts, all of which the
 * site regenerates on the next request.
 *
 * Usage:
 *   node scripts/site-cache-flush.mjs --resource-uuid <uuid>
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

let sshKeyPath = sshKeyPathEnv;
let cleanupDir = "";
if (!sshKeyPath && (sshKeyRaw || sshKeyB64)) {
  const decoded = sshKeyB64 ? Buffer.from(sshKeyB64, "base64").toString("utf8") : sshKeyRaw;
  const normalized = normalizePrivateKey(decoded);
  if (!normalized) bail("SSH private key empty after normalization.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-flush-key-"));
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
  const r = spawnSync("ssh", args, { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
  if (r.error) return { ok: false, stdout: r.stdout || "", stderr: `${r.stderr || ""}\nssh spawn failed: ${r.error.message}` };
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function buildScript() {
  return `set -uo pipefail
RUUID=${shQuote(resourceUuid)}

read_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | awk -F= -v k="$2" '$1==k{print substr($0,index($0,"=")+1)}' | tail -n 1; }

# Whole-segment match, same rule as the backup scripts: Coolify names service
# containers <app>-<uuid> but application containers <uuid>-<deployment-ts>.
CONTAINERS=$(docker ps --format '{{.Names}}' | grep -E "(^|-)$RUUID($|-)" || true)
[ -n "$CONTAINERS" ] || { echo "RESULT=fail_no_containers"; exit 1; }

WP=$(echo "$CONTAINERS" | grep -m1 '^wordpress-' || true)
if [ -z "$WP" ]; then
  # Not a WordPress stack (or the container is not running).
  echo "RESULT=fail_no_wordpress"
  exit 1
fi
echo "WP_CONTAINER=$WP"

ROOT=/var/www/html

# ── 1. Object cache via wp-cli, when the image actually has it ──
if docker exec "$WP" sh -lc "command -v wp" >/dev/null 2>&1; then
  if docker exec "$WP" sh -lc "wp cache flush --allow-root --path=$ROOT" >/dev/null 2>&1; then
    echo "WP_CLI=flushed"
  else
    echo "WP_CLI=failed"
  fi
else
  # The stock wordpress image ships no wp-cli. Absent, not broken.
  echo "WP_CLI=absent"
fi

# ── 2. Page cache FILES written by caching plugins ──
# Counted before deleting so the result reports real work rather than the exit
# status of an rm that matched nothing. Only the CONTENTS go: the directory
# itself is often plugin-owned with specific permissions.
#
# More than one directory because not every plugin uses wp-content/cache.
# LiteSpeed writes to wp-content/litespeed, so a site using it was reported as
# having no page cache at all while serving stale pages from one.
CACHE_DIRS="$ROOT/wp-content/cache $ROOT/wp-content/litespeed"
FC_TOTAL=0
FC_FAILED=0
for d in $CACHE_DIRS; do
  docker exec "$WP" sh -lc "[ -d $d ]" >/dev/null 2>&1 || continue
  n=$(docker exec "$WP" sh -lc "find $d -mindepth 1 | wc -l" 2>/dev/null | tr -dc '0-9')
  [ "\${n:-0}" -gt 0 ] || continue
  if docker exec "$WP" sh -lc "find $d -mindepth 1 -maxdepth 1 -exec rm -rf {} +" >/dev/null 2>&1; then
    FC_TOTAL=$((FC_TOTAL + \${n:-0}))
  else
    FC_FAILED=1
  fi
done
if [ "$FC_TOTAL" -gt 0 ]; then
  echo "FILE_CACHE=flushed"
  echo "FILE_CACHE_ENTRIES=$FC_TOTAL"
  [ "$FC_FAILED" = 1 ] && echo "FILE_CACHE_PARTIAL=1"
elif [ "$FC_FAILED" = 1 ]; then
  echo "FILE_CACHE=failed"
else
  # No cache directory, or one that is already empty. Saying "flushed" here
  # would overstate it.
  echo "FILE_CACHE=absent"
fi

# ── 3. Elementor's generated CSS ──
# Elementor compiles each page's styles into a file under
# uploads/elementor/css and serves that, so an edited design stays invisible
# until those files are regenerated. Nothing above clears them: they are not the
# object cache and not a caching plugin's directory.
#
# Only the CONTENTS of css/ go. Its siblings under uploads/elementor —
# custom-icons, google-fonts, screenshots, thumbs, design-system-sync — are
# uploaded assets, not cache, and deleting those would destroy real data.
EL_PLUGIN="$ROOT/wp-content/plugins/elementor"
EL_CSS="$ROOT/wp-content/uploads/elementor/css"
if ! docker exec "$WP" sh -lc "[ -d $EL_PLUGIN ]" >/dev/null 2>&1; then
  echo "ELEMENTOR=absent"
elif docker exec "$WP" sh -lc "command -v wp" >/dev/null 2>&1 \
  && docker exec "$WP" sh -lc "wp plugin is-active elementor --allow-root --path=$ROOT" >/dev/null 2>&1; then
  # Preferred when available: Elementor's own command also resets the metadata
  # that tracks which files are current. No image on this platform ships wp-cli
  # today, so in practice the file path below is what runs — but an image that
  # does ship it should use the supported command rather than deleting files.
  if docker exec "$WP" sh -lc "wp elementor flush-css --allow-root --path=$ROOT" >/dev/null 2>&1; then
    echo "ELEMENTOR=flushed"
  else
    echo "ELEMENTOR=failed"
  fi
elif docker exec "$WP" sh -lc "[ -d $EL_CSS ]" >/dev/null 2>&1; then
  EL_N=$(docker exec "$WP" sh -lc "find $EL_CSS -mindepth 1 -maxdepth 1 -name '*.css' | wc -l" 2>/dev/null | tr -dc '0-9')
  if [ "\${EL_N:-0}" -gt 0 ]; then
    if docker exec "$WP" sh -lc "find $EL_CSS -mindepth 1 -maxdepth 1 -name '*.css' -delete" >/dev/null 2>&1; then
      echo "ELEMENTOR=flushed"
      echo "ELEMENTOR_FILES=$EL_N"
    else
      echo "ELEMENTOR=failed"
    fi
  else
    # Elementor is installed but has nothing compiled yet.
    echo "ELEMENTOR=absent"
  fi
else
  echo "ELEMENTOR=absent"
fi

# ── 4. Persistent object cache (Redis) ──
# The object-cache.php drop-in is the RELIABLE signal that a persistent object
# cache exists. Env vars are not: WordPress is normally pointed at Redis from
# wp-config.php, so an env-only probe reports "no Redis" for a site that very
# much has one — and "absent" would then be a lie about a cache still serving
# stale data.
DROPIN=0
docker exec "$WP" sh -lc '[ -f /var/www/html/wp-content/object-cache.php ]' >/dev/null 2>&1 && DROPIN=1

RHOST=$(read_env "$WP" WP_REDIS_HOST); [ -n "$RHOST" ] || RHOST=$(read_env "$WP" REDIS_HOST)
if [ -z "$RHOST" ]; then
  # Parsed on THIS side of the exec so awk can split on the PHP string
  # delimiter without nested-quote gymnastics.
  # define('WP_REDIS_HOST', 'host') -> field 4.
  #
  # ^[^/#]* rejects commented-out defines. A plain match would happily return
  # the host from a commented-out define -- a stale name the site does not use,
  # and if a container answers to it we would be flushing somebody else's Redis.
  RCONF=$(docker exec "$WP" sh -lc 'grep -m1 -E "^[^/#]*WP_REDIS_HOST" /var/www/html/wp-config.php' 2>/dev/null)
  RHOST=$(printf '%s' "$RCONF" | awk -F"'" '{print $4}')
fi

if [ -n "$RHOST" ] && docker ps --format '{{.Names}}' | grep -qx "$RHOST"; then
  RPASS=$(read_env "$WP" WP_REDIS_PASSWORD); [ -n "$RPASS" ] || RPASS=$(read_env "$RHOST" REDIS_PASSWORD)
  if [ -n "$RPASS" ]; then
    OK=$(docker exec -e REDISCLI_AUTH="$RPASS" "$RHOST" sh -lc "redis-cli FLUSHALL" 2>/dev/null | tr -d '\\r')
  else
    OK=$(docker exec "$RHOST" sh -lc "redis-cli FLUSHALL" 2>/dev/null | tr -d '\\r')
  fi
  if [ "$OK" = "OK" ]; then echo "REDIS=flushed"; else echo "REDIS=failed"; fi
elif [ "$DROPIN" = 1 ]; then
  # A persistent object cache IS installed, but its backend could not be
  # resolved to a container here. Reporting "absent" would tell the operator
  # there is no object cache when there is one they cannot clear.
  echo "REDIS=failed"
  echo "REDIS_NOTE=object_cache_dropin_present_backend_unresolved"
else
  echo "REDIS=absent"
fi

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

/**
 * What did the flush actually flush?
 *
 * Mirrors describeCacheFlush in apps/web/src/lib/cache-flush.ts, which carries
 * the rationale and the unit tests. Duplicated rather than imported because
 * this script runs standalone under plain node with no bundler and no path
 * aliases — the same arrangement as parseForgotten in scripts/site-backup.mjs.
 */
function describeCacheFlush(input) {
  // Keep these two lists in step with TARGET_ORDER and LABELS in
  // apps/web/src/lib/cache-flush.ts. Cloudflare is absent here on purpose: it
  // is purged by the API route, which re-derives the verdict over every target,
  // and this script has no business making network calls to a CDN.
  const LABELS = {
    wpCli: "object cache",
    fileCache: "page cache files",
    elementor: "Elementor CSS",
    redis: "Redis"
  };
  const details = [];
  for (const key of ["wpCli", "fileCache", "elementor", "redis"]) {
    const status = input[key];
    if (status === "flushed" || status === "absent" || status === "failed") {
      details.push({ target: LABELS[key], status });
    }
  }
  const join = (items) =>
    items.length <= 1
      ? items[0] ?? ""
      : items.length === 2
        ? `${items[0]} and ${items[1]}`
        : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

  const flushed = details.filter((d) => d.status === "flushed").map((d) => d.target);
  const failed = details.filter((d) => d.status === "failed").map((d) => d.target);

  if (flushed.length === 0) {
    if (failed.length > 0) {
      return { flushed: false, reason: "flush_failed", message: `The cache could not be flushed (${failed.join(", ")} failed). Nothing was cleared.`, details };
    }
    return {
      flushed: false,
      reason: "nothing_to_flush",
      message: "Nothing to flush — this site has no caching plugin, object cache, Elementor CSS or Redis.",
      details
    };
  }
  if (failed.length > 0) {
    return { flushed: true, reason: "flushed_partial", message: `Flushed ${join(flushed)}, but ${join(failed)} could not be cleared.`, details };
  }
  return { flushed: true, reason: "flushed", message: `Flushed ${join(flushed)}.`, details };
}

console.log(`[site-cache-flush] host=${sshHost} resource=${resourceUuid}`);
try {
  const r = runSsh(buildScript());
  if (r.stderr.trim()) console.error(r.stderr.trim());
  console.log(r.stdout.trim());
  const k = parseKV(r.stdout);

  if (k.RESULT !== "ok") {
    const reason = k.RESULT || "unknown";
    const message =
      reason === "fail_no_wordpress"
        ? "No running WordPress container was found for this app, so there was no cache to flush."
        : reason === "fail_no_containers"
          ? "No running containers were found for this app."
          : "The cache flush did not complete.";
    console.log(`SITE_CACHE_FLUSH_RESULT=${JSON.stringify({ ok: false, reason, message })}`);
    console.log("\nRESULT: FAIL");
    process.exit(1);
  }

  const outcome = describeCacheFlush({
    wpCli: k.WP_CLI,
    fileCache: k.FILE_CACHE,
    elementor: k.ELEMENTOR,
    redis: k.REDIS
  });
  const payload = {
    ok: outcome.flushed,
    reason: outcome.reason,
    message: outcome.message,
    details: outcome.details,
    entriesRemoved: k.FILE_CACHE_ENTRIES ? Number(k.FILE_CACHE_ENTRIES) : null,
    // Raw per-target statuses, so a caller that can reach caches this script
    // cannot — Cloudflare's edge, which needs no host access — can add its own
    // result and re-derive the verdict over all four rather than parsing the
    // rendered labels back out of `details`.
    targets: {
      wpCli: k.WP_CLI ?? null,
      fileCache: k.FILE_CACHE ?? null,
      elementor: k.ELEMENTOR ?? null,
      redis: k.REDIS ?? null
    },
    elementorFilesRemoved: k.ELEMENTOR_FILES ? Number(k.ELEMENTOR_FILES) : null
  };
  console.log(`SITE_CACHE_FLUSH_RESULT=${JSON.stringify(payload)}`);

  // A site with no caching layer is not a failed run. Exiting non-zero here
  // would fail any CI step that flushes caches across a fleet, and printing
  // FAIL against a perfectly healthy stock WordPress install is the same
  // misreporting this script was written to remove — just one layer down.
  const cliOk = outcome.flushed || outcome.reason === "nothing_to_flush";
  console.log(outcome.flushed ? "\nRESULT: PASS" : cliOk ? "\nRESULT: NOTHING TO FLUSH" : "\nRESULT: FAIL");
  process.exit(cliOk ? 0 : 1);
} finally {
  if (cleanupDir) { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
