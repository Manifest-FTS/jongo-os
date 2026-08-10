/**
 * Rewriting a WordPress site's URLs across its whole database.
 *
 * Changing wp_options.siteurl/home — which is all the staging sync did — moves
 * the site but leaves every absolute URL baked into content pointing at the old
 * host. On a real migrated site that meant 75 post guids, an 84 KB page-builder
 * JSON blob, and a widget option still naming gsequality.wpengine.com.
 *
 * Why this is not `UPDATE ... SET col = REPLACE(col, old, new)`:
 *
 * 1. PHP-serialized values carry byte-length prefixes. A real row on that site
 *    reads `s:131:"<img src="https://gsequality.wpengine.com/...">"`. Replacing a
 *    23-character host with a 22-character one leaves the prefix claiming 131
 *    bytes for a 130-byte string, `unserialize()` returns false, and WordPress
 *    treats the whole option as empty — so every widget in it disappears. The
 *    replace has to unserialize, substitute, and re-serialize so lengths are
 *    recomputed. This is what `wp search-replace --precise` does; wp-cli is not
 *    installed in these containers, so the same walk is done here.
 *
 * 2. Page builders store JSON with escaped slashes: `https:\/\/old.example`.
 *    A replace written against `https://old.example` silently misses all of it.
 *    Replacing the BARE HOST instead covers the plain, escaped and
 *    protocol-relative spellings at once, because escaping only ever affects the
 *    slashes and never the host.
 *
 * The pair-building and report-parsing live here, apart from execution, because
 * they are the parts that are easy to get quietly wrong and they must be
 * testable without a database to destroy.
 */

export type UrlParts = { scheme: string; host: string };

/** Accepts a bare host or a full URL; trailing slashes and case are normalised. */
export function parseSiteUrl(value: string): UrlParts | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  // Trailing slashes are NOT stripped first: doing so turns "https://" into
  // "https:", which then gets a scheme prepended and parses as the host "https".
  // The URL parser discards the path anyway, and rejects "https://" outright.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    return {
      scheme: url.protocol.replace(":", "").toLowerCase(),
      // Port is kept: a host:port pair is what appears in content on a
      // non-standard port, and dropping it would rewrite to an unreachable URL.
      host: url.port ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase()
    };
  } catch {
    return null;
  }
}

export type ReplacementPair = { from: string; to: string };

/**
 * The ordered substitutions to apply to every string in the database.
 *
 * Host-first is deliberate. Replacing the bare host handles `https://old`,
 * `https:\/\/old` and `//old` in a single pass. Only once the host is the new one
 * does a scheme change become a simple, unambiguous second substitution — doing
 * it the other way round means the host replace would have to be written three
 * times, once per spelling, and the escaped form is the one that gets forgotten.
 */
export function buildReplacementPairs(fromUrl: string, toUrl: string): ReplacementPair[] {
  const from = parseSiteUrl(fromUrl);
  const to = parseSiteUrl(toUrl);
  if (!from || !to) return [];
  if (from.host === to.host && from.scheme === to.scheme) return [];

  const pairs: ReplacementPair[] = [];
  if (from.host !== to.host) {
    pairs.push({ from: from.host, to: to.host });
  }

  // Applied after the host swap, so it matches the already-rewritten text.
  if (from.scheme !== to.scheme) {
    pairs.push({ from: `${from.scheme}://${to.host}`, to: `${to.scheme}://${to.host}` });
    // The escaped spelling has to be listed explicitly here: unlike the host,
    // this pattern contains the slashes that JSON escapes.
    pairs.push({ from: `${from.scheme}:\\/\\/${to.host}`, to: `${to.scheme}:\\/\\/${to.host}` });
  }

  return pairs;
}

export type RewriteTableReport = { table: string; column: string; rowsChanged: number };

export type RewriteReport = {
  ok: boolean
  dryRun: boolean;
  error: string | null;
  tables: RewriteTableReport[];
  rowsChanged: number;
  /** Rows whose serialized value could not be parsed and were left untouched. */
  skippedUnserializable: number;
};

/**
 * The PHP that performs the walk, run inside the WordPress container.
 *
 * SHORTINIT again: this needs `$wpdb` and nothing else, and booting plugins on a
 * site being migrated is both pointless and a way to inherit their fatals.
 *
 * Primary keys are used for the writes rather than `WHERE col = old_value`, so a
 * row is updated exactly once and a value appearing twice cannot be double
 * written.
 */
export const URL_REWRITE_PHP = String.raw`<?php
define('SHORTINIT', true);
$root = getenv('JONGO_WP_ROOT');
if (!$root) { $root = '/var/www/html'; }
if (!file_exists($root . '/wp-load.php')) {
  echo json_encode(array('ok' => false, 'error' => 'wp-load.php not found under ' . $root));
  exit(0);
}
require_once $root . '/wp-load.php';
global $wpdb;
if (!isset($wpdb) || !is_object($wpdb)) {
  echo json_encode(array('ok' => false, 'error' => 'wpdb unavailable under SHORTINIT'));
  exit(0);
}

$payload = json_decode(getenv('JONGO_REWRITE'), true);
if (!is_array($payload) || empty($payload['pairs'])) {
  echo json_encode(array('ok' => false, 'error' => 'no replacement pairs supplied'));
  exit(0);
}
$dryRun = !empty($payload['dryRun']);
$from = array();
$to = array();
foreach ($payload['pairs'] as $pair) {
  if (!isset($pair['from']) || $pair['from'] === '') { continue; }
  $from[] = $pair['from'];
  $to[] = isset($pair['to']) ? $pair['to'] : '';
}
if (!count($from)) {
  echo json_encode(array('ok' => false, 'error' => 'no usable replacement pairs'));
  exit(0);
}

$skipped = 0;

// Recursive, serialization-aware substitution. A string that unserializes is
// rebuilt with serialize() so every length prefix is recomputed; a plain string
// is substituted directly.
function jongo_walk($data, $from, $to, &$skipped, $depth = 0) {
  if ($depth > 30) { return $data; }

  if (is_string($data)) {
    if ($data !== '' && (@preg_match('/^[aOs]:\d+:/', $data) || $data === 'b:0;')) {
      $un = @unserialize($data);
      if ($un !== false || $data === 'b:0;') {
        return serialize(jongo_walk($un, $from, $to, $skipped, $depth + 1));
      }
      // Looked serialized and was not parseable. Substituting would break its
      // length prefixes, so it is left exactly as found and counted.
      $skipped++;
      return $data;
    }
    return str_replace($from, $to, $data);
  }

  if (is_array($data)) {
    $out = array();
    foreach ($data as $k => $v) {
      $out[is_string($k) ? str_replace($from, $to, $k) : $k] = jongo_walk($v, $from, $to, $skipped, $depth + 1);
    }
    return $out;
  }

  if (is_object($data)) {
    if ($data instanceof __PHP_Incomplete_Class) { $skipped++; return $data; }
    $out = clone $data;
    foreach (get_object_vars($out) as $k => $v) {
      $out->$k = jongo_walk($v, $from, $to, $skipped, $depth + 1);
    }
    return $out;
  }

  return $data;
}

$targets = array(
  array($wpdb->options,     'option_id',   array('option_name', 'option_value')),
  array($wpdb->posts,       'ID',          array('post_content', 'post_excerpt', 'post_title', 'guid')),
  array($wpdb->postmeta,    'meta_id',     array('meta_value')),
  array($wpdb->termmeta,    'meta_id',     array('meta_value')),
  array($wpdb->term_taxonomy, 'term_taxonomy_id', array('description')),
  array($wpdb->comments,    'comment_ID',  array('comment_content', 'comment_author_url')),
  array($wpdb->commentmeta, 'meta_id',     array('meta_value')),
  array($wpdb->usermeta,    'umeta_id',    array('meta_value'))
);

$report = array();
$totalChanged = 0;

foreach ($targets as $target) {
  list($table, $pk, $columns) = $target;
  $exists = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $table));
  if (empty($exists)) { continue; }

  foreach ($columns as $column) {
    // Identifiers are not quoted because they are not user input: every table
    // comes from $wpdb and every column from the fixed list above, and none is a
    // reserved word. Backtick quoting would be the habit, but a backtick cannot
    // appear in the TypeScript template literal that carries this program.
    $where = array();
    foreach ($from as $needle) {
      $where[] = $wpdb->prepare("{$column} LIKE %s", '%' . $wpdb->esc_like($needle) . '%');
    }
    $sql = "SELECT {$pk} AS pk, {$column} AS val FROM {$table} WHERE (" . implode(' OR ', $where) . ')';

    $changed = 0;
    $batch = 200;
    $lastPk = 0;
    // Paged on the primary key, not OFFSET. Rewritten rows stop matching the
    // WHERE, so an offset window would skip unprocessed rows; and a row that
    // matches but cannot be changed (an unparseable serialized value) would be
    // re-selected forever. A high-water mark advances monotonically in both dry
    // and live runs and is immune to the result set shrinking underneath it.
    while (true) {
      $rows = $wpdb->get_results(
        $sql . " AND {$pk} > " . (int) $lastPk . " ORDER BY {$pk} ASC LIMIT {$batch}"
      );
      if (empty($rows)) { break; }
      foreach ($rows as $row) {
        $lastPk = (int) $row->pk;
        $updated = jongo_walk($row->val, $from, $to, $skipped);
        if ($updated === $row->val) { continue; }
        $changed++;
        if (!$dryRun) {
          $wpdb->update($table, array($column => $updated), array($pk => $row->pk));
        }
      }
      if (count($rows) < $batch) { break; }
    }

    if ($changed > 0) {
      $report[] = array('table' => $table, 'column' => $column, 'rowsChanged' => $changed);
      $totalChanged += $changed;
    }
  }
}

echo json_encode(array(
  'ok' => true,
  'dryRun' => $dryRun,
  'rowsChanged' => $totalChanged,
  'skippedUnserializable' => $skipped,
  'tables' => $report
));
`;

export function parseRewriteReport(raw: string): RewriteReport {
  const empty: RewriteReport = {
    ok: false,
    dryRun: true,
    error: null,
    tables: [],
    rowsChanged: 0,
    skippedUnserializable: 0
  };

  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ...empty, error: "rewrite produced no JSON report" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ...empty, error: "rewrite report was not valid JSON" };
  }

  const payload = (parsed ?? {}) as Record<string, unknown>;
  if (payload.ok !== true) {
    const error = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "rewrite reported failure";
    return { ...empty, error };
  }

  const tables = Array.isArray(payload.tables)
    ? payload.tables
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
        .map((row) => ({
          table: String(row.table ?? ""),
          column: String(row.column ?? ""),
          rowsChanged: Number(row.rowsChanged ?? 0) || 0
        }))
    : [];

  return {
    ok: true,
    dryRun: payload.dryRun === true,
    error: null,
    tables,
    rowsChanged: Number(payload.rowsChanged ?? 0) || 0,
    skippedUnserializable: Number(payload.skippedUnserializable ?? 0) || 0
  };
}

/** One line for a log or an API response. */
export function summarizeRewriteReport(report: RewriteReport): string {
  if (!report.ok) return report.error ?? "URL rewrite failed.";

  const verb = report.dryRun ? "would change" : "changed";
  const parts = [`${verb} ${report.rowsChanged} row${report.rowsChanged === 1 ? "" : "s"}`];
  if (report.tables.length > 0) {
    parts.push(report.tables.map((t) => `${t.table}.${t.column}=${t.rowsChanged}`).join(", "));
  }
  if (report.skippedUnserializable > 0) {
    // Never silent: an unparseable serialized value is a row that still holds the
    // old URL, and pretending the rewrite was complete is how it stays broken.
    parts.push(`${report.skippedUnserializable} unparseable serialized value(s) left untouched`);
  }
  return parts.join(" — ");
}
