/**
 * Reading a WordPress site's plugin inventory without credentials.
 *
 * The REST collector needs a per-site application password, which had been set
 * up for 8 of 51 apps — so the Plugins page was empty for the rest. Jongo owns
 * these containers, so it can read the same facts directly and needs no
 * credentials at all.
 *
 * Two decisions matter here and both were settled by testing against real sites:
 *
 * 1. SHORTINIT. Booting WordPress properly (`wp-load.php` without SHORTINIT)
 *    executes every active plugin, and on one live site that died with a fatal
 *    error from a broken plugin (mapsvg, missing schema file). The inventory
 *    would have been hidden by exactly the kind of bug it exists to reveal. With
 *    SHORTINIT only the database layer loads, no plugin code runs, and that same
 *    site reports all 32 plugins.
 *
 * 2. Headers are parsed from the files, not via `get_plugins()`, because that
 *    function needs a booted WordPress. This matches what WordPress itself does:
 *    scan the top level of each plugin directory and treat any file carrying a
 *    `Plugin Name:` header as a plugin.
 *
 * Update availability comes from WordPress's own `update_plugins` site
 * transient. That is a cache maintained by wp-cron, so a site whose cron is dead
 * reports everything as up to date — which looks reassuring and is wrong. The
 * transient's `last_checked` is therefore carried through and surfaced, rather
 * than trusted silently.
 *
 * The PHP and the shell are built as strings here so the parts that are easy to
 * get quietly wrong — the parsing and the shell quoting — are testable without
 * an SSH host or a container.
 */

/** Exact strings the Plugins page branches on for its badges. */
export const UPDATE_AVAILABLE_LABEL = "Update available";
export const UP_TO_DATE_LABEL = "Up to date";

export type ProbedPlugin = {
  /** Plugin file relative to wp-content/plugins, e.g. "akismet/akismet.php". */
  file: string;
  name: string;
  version: string | null;
  active: boolean;
  updateAvailable: boolean;
  newVersion: string | null;
};

export type PluginProbeResult =
  | {
      ok: true;
      wpVersion: string | null;
      /** Unix seconds from the update_plugins transient, when present. */
      updateDataCheckedAt: number | null;
      plugins: ProbedPlugin[];
    }
  | { ok: false; error: string };

/**
 * Runs inside the WordPress container. Emits a single JSON object on stdout and
 * never exits non-zero for a site-level problem — an unreadable site is a result
 * to record, not a crash to retry.
 */
export const PLUGIN_PROBE_PHP = `<?php
define('SHORTINIT', true);
$root = getenv('JONGO_WP_ROOT');
if (!$root) { $root = '/var/www/html'; }
if (!file_exists($root . '/wp-load.php')) {
  echo json_encode(array('ok' => false, 'error' => 'wp-load.php not found under ' . $root));
  exit(0);
}
require_once $root . '/wp-load.php';
global $wpdb, $wp_version;
if (!isset($wpdb) || !is_object($wpdb)) {
  echo json_encode(array('ok' => false, 'error' => 'wpdb unavailable under SHORTINIT'));
  exit(0);
}
$p = $wpdb->prefix;

function jongo_unser($raw) {
  if (!is_string($raw) || $raw === '') { return null; }
  $v = @unserialize($raw);
  return ($v === false && $raw !== 'b:0;') ? null : $v;
}

$active = (array) jongo_unser($wpdb->get_var("SELECT option_value FROM {$p}options WHERE option_name = 'active_plugins'"));

$network = array();
$tables = $wpdb->get_col("SHOW TABLES LIKE '{$p}sitemeta'");
if (!empty($tables)) {
  $nv = jongo_unser($wpdb->get_var("SELECT meta_value FROM {$p}sitemeta WHERE meta_key = 'active_sitewide_plugins' LIMIT 1"));
  if (is_array($nv)) { $network = $nv; }
}

$upd = jongo_unser($wpdb->get_var("SELECT option_value FROM {$p}options WHERE option_name = '_site_transient_update_plugins'"));
$resp = (is_object($upd) && isset($upd->response) && is_array($upd->response)) ? $upd->response : array();
$lastChecked = (is_object($upd) && isset($upd->last_checked)) ? (int) $upd->last_checked : null;

function jongo_header($file) {
  $fp = @fopen($file, 'r');
  if (!$fp) { return null; }
  $head = fread($fp, 8192);
  fclose($fp);
  $head = str_replace("\\r", "\\n", $head);
  if (!preg_match('/^[ \\t\\/*#@]*Plugin Name:(.*)$/mi', $head, $n)) { return null; }
  $version = preg_match('/^[ \\t\\/*#@]*Version:(.*)$/mi', $head, $v) ? trim($v[1]) : null;
  return array('name' => trim($n[1]), 'version' => ($version === '' ? null : $version));
}

$dir = $root . '/wp-content/plugins';
$candidates = array();
foreach ((array) @glob($dir . '/*.php') as $f) { $candidates[basename($f)] = $f; }
foreach ((array) @glob($dir . '/*', GLOB_ONLYDIR) as $d) {
  foreach ((array) @glob($d . '/*.php') as $f) { $candidates[basename($d) . '/' . basename($f)] = $f; }
}

$plugins = array();
foreach ($candidates as $rel => $abs) {
  $h = jongo_header($abs);
  if (!$h) { continue; }
  $plugins[] = array(
    'file' => $rel,
    'name' => $h['name'],
    'version' => $h['version'],
    'active' => (in_array($rel, $active, true) || isset($network[$rel])),
    'updateAvailable' => isset($resp[$rel]),
    'newVersion' => (isset($resp[$rel]) && isset($resp[$rel]->new_version)) ? $resp[$rel]->new_version : null
  );
}
usort($plugins, function ($a, $b) { return strcasecmp($a['name'], $b['name']); });

echo json_encode(array(
  'ok' => true,
  'wpVersion' => isset($wp_version) ? $wp_version : null,
  'updateDataCheckedAt' => $lastChecked,
  'plugins' => $plugins
));
`;

/** Single-quoted shell literal. */
function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The bash program piped to `ssh host bash -s`.
 *
 * Container discovery matches site-backup.mjs: Coolify names service containers
 * `<app>-<uuid>`, so the uuid is matched as a whole segment rather than by
 * prefix. The PHP arrives on the container's stdin via a quoted heredoc, which
 * avoids nesting it through two layers of shell quoting.
 *
 * Deploys are yielded to, for the same reason backups yield: a `coolify-helper`
 * container means an image build is in flight, and that is the peak memory
 * moment on the host.
 */
export function buildPluginProbeScript(resourceUuid: string): string {
  return `set -uo pipefail
RUUID=${shQuote(resourceUuid)}

if docker ps --format '{{.Names}} {{.Image}}' | grep -qE 'coolify-helper'; then
  echo 'JONGO_RESULT=deferred_deploy_in_progress'
  exit 0
fi

CONTAINERS=$(docker ps --format '{{.Names}}' | grep -E "(^|-)$RUUID($|-)" || true)
[ -n "$CONTAINERS" ] || { echo 'JONGO_RESULT=no_containers'; exit 0; }

WP_CONTAINER=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  case "$c" in wordpress-*) WP_CONTAINER="$c";; esac
done <<EOF
$CONTAINERS
EOF

if [ -z "$WP_CONTAINER" ]; then
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    if docker exec "$c" test -f /var/www/html/wp-load.php >/dev/null 2>&1; then WP_CONTAINER="$c"; break; fi
  done <<EOF
$CONTAINERS
EOF
fi

[ -n "$WP_CONTAINER" ] || { echo 'JONGO_RESULT=no_wordpress_container'; exit 0; }

echo 'JONGO_RESULT=ok'
docker exec -i "$WP_CONTAINER" php <<'JONGOPHPEOF'
${PLUGIN_PROBE_PHP}
JONGOPHPEOF
`;
}

export type ProbeTransportOutcome =
  | { kind: "json"; raw: string }
  | { kind: "deferred" }
  | { kind: "no_containers" }
  | { kind: "no_wordpress_container" }
  | { kind: "unusable"; detail: string };

/**
 * Split the shell marker line from the JSON payload.
 *
 * Kept separate from JSON parsing because "the host told us it is busy" and "the
 * site returned something we cannot read" are different outcomes with different
 * follow-ups, and collapsing them is how a deferral gets recorded as a failure.
 */
export function readProbeTransport(stdout: string): ProbeTransportOutcome {
  const text = String(stdout ?? "");
  const marker = /^JONGO_RESULT=(.+)$/m.exec(text);
  if (!marker) {
    return { kind: "unusable", detail: "probe produced no result marker" };
  }

  const result = marker[1].trim();
  if (result === "deferred_deploy_in_progress") return { kind: "deferred" };
  if (result === "no_containers") return { kind: "no_containers" };
  if (result === "no_wordpress_container") return { kind: "no_wordpress_container" };
  if (result !== "ok") return { kind: "unusable", detail: `unexpected probe result: ${result}` };

  const raw = text.slice((marker.index ?? 0) + marker[0].length).trim();
  if (!raw) return { kind: "unusable", detail: "probe returned no payload" };
  return { kind: "json", raw };
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Parse the probe's JSON.
 *
 * PHP notices and warnings can precede the payload on stdout even when the read
 * succeeded, so the object is located rather than assumed to start at byte zero.
 */
export function parsePluginProbeOutput(raw: string): PluginProbeResult {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, error: "probe output contained no JSON object" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, error: "probe output was not valid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "probe output was not an object" };
  }

  const payload = parsed as Record<string, unknown>;
  if (payload.ok !== true) {
    return { ok: false, error: asStringOrNull(payload.error) ?? "probe reported failure" };
  }

  const rows = Array.isArray(payload.plugins) ? payload.plugins : [];
  const plugins: ProbedPlugin[] = rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map((row) => ({
      file: asStringOrNull(row.file) ?? "",
      name: asStringOrNull(row.name) ?? "",
      version: asStringOrNull(row.version),
      active: row.active === true,
      updateAvailable: row.updateAvailable === true,
      newVersion: asStringOrNull(row.newVersion)
    }))
    // A row with no name cannot be rendered or acted on; dropping it beats
    // showing a blank line in the table.
    .filter((plugin) => plugin.name.length > 0);

  const checkedAt = typeof payload.updateDataCheckedAt === "number" && Number.isFinite(payload.updateDataCheckedAt)
    ? payload.updateDataCheckedAt
    : null;

  return {
    ok: true,
    wpVersion: asStringOrNull(payload.wpVersion),
    updateDataCheckedAt: checkedAt && checkedAt > 0 ? checkedAt : null,
    plugins
  };
}

export type PluginInventoryRow = {
  name: string;
  status: string;
  version: string | null;
  updateStatus: string;
  securityIssues: string | null;
};

export type PluginInventorySummary = {
  rows: PluginInventoryRow[];
  activePlugins: number;
  inactivePlugins: number;
  updatesAvailable: number;
};

/**
 * Shape the probe into what the Plugins page already renders.
 *
 * The status strings are exact on purpose: the page branches on
 * `updateStatus === "Update available"` to decide the warning badge, so a
 * differently-cased variant renders as plain text and the row silently loses its
 * warning.
 */
export function toPluginInventory(plugins: ProbedPlugin[]): PluginInventorySummary {
  const rows = plugins.map((plugin) => ({
    name: plugin.name,
    status: plugin.active ? "Active" : "Inactive",
    version: plugin.version,
    updateStatus: plugin.updateAvailable ? UPDATE_AVAILABLE_LABEL : UP_TO_DATE_LABEL,
    // Left null deliberately: no vulnerability feed is wired up, and inventing a
    // reassuring "None" would assert something never checked.
    securityIssues: null as string | null
  }));

  return {
    rows,
    activePlugins: rows.filter((row) => row.status === "Active").length,
    inactivePlugins: rows.filter((row) => row.status === "Inactive").length,
    updatesAvailable: rows.filter((row) => row.updateStatus === UPDATE_AVAILABLE_LABEL).length
  };
}

export const UPDATE_DATA_STALE_AFTER_HOURS = 48;

export type UpdateDataFreshness = {
  /** Null when the transient carried no timestamp. */
  ageHours: number | null;
  stale: boolean;
  detail: string;
};

/**
 * How much to trust "Up to date".
 *
 * WordPress refreshes the update transient from wp-cron. If cron is dead the
 * cache freezes and every plugin reads as current, so an old timestamp has to be
 * shown rather than quietly believed.
 */
export function describeUpdateDataFreshness(
  updateDataCheckedAt: number | null,
  now: Date = new Date()
): UpdateDataFreshness {
  if (!updateDataCheckedAt || updateDataCheckedAt <= 0) {
    return {
      ageHours: null,
      stale: true,
      detail: "WordPress has no record of when it last checked for plugin updates, so update status may be incomplete."
    };
  }

  const ageHours = Math.max(0, Math.round((now.getTime() - updateDataCheckedAt * 1000) / 3_600_000));
  if (ageHours > UPDATE_DATA_STALE_AFTER_HOURS) {
    return {
      ageHours,
      stale: true,
      detail: `WordPress last checked for plugin updates ${ageHours}h ago, so "${UP_TO_DATE_LABEL}" may be out of date. Check that wp-cron is running on this site.`
    };
  }

  return {
    ageHours,
    stale: false,
    detail: `WordPress last checked for plugin updates ${ageHours}h ago.`
  };
}
