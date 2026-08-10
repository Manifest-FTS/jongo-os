/**
 * Executing the URL rewrite inside a site's WordPress container.
 *
 * Kept apart from wp-url-rewrite.ts so the pair building, the PHP walk and the
 * report parsing stay unit-testable, and this file holds only the transport.
 *
 * The replacement pairs travel as JSON in an environment variable rather than
 * interpolated into the PHP or the shell. Two layers of quoting around a value
 * that contains slashes, colons and possibly a hostile hostname is how a rewrite
 * turns into arbitrary code on the production host.
 */

import { buildReplacementPairs, parseRewriteReport, URL_REWRITE_PHP, type RewriteReport } from "./wp-url-rewrite";
import { isSshHostConfigured, runHostScript } from "./ssh-exec";

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The bash program. Container discovery matches site-backup.mjs and the plugin
 * probe: Coolify names service containers `<app>-<uuid>`, so the uuid is matched
 * as a whole segment.
 */
export function buildUrlRewriteScript(input: { resourceUuid: string; payloadJson: string }): string {
  return `set -uo pipefail
RUUID=${shQuote(input.resourceUuid)}
JONGO_REWRITE=${shQuote(input.payloadJson)}
export JONGO_REWRITE

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

[ -n "$WP_CONTAINER" ] || { echo 'JONGO_RESULT=no_wordpress_container'; exit 0; }

echo 'JONGO_RESULT=ok'
docker exec -i -e JONGO_REWRITE="$JONGO_REWRITE" "$WP_CONTAINER" php <<'JONGOPHPEOF'
${URL_REWRITE_PHP}
JONGOPHPEOF
`;
}

export type RunUrlRewriteResult = RewriteReport & {
  /** The substitutions that were requested, for the audit trail. */
  pairs: Array<{ from: string; to: string }>;
};

/**
 * Rewrite `fromUrl` to `toUrl` across one site's database.
 *
 * Defaults to a dry run. This mutates a live customer database, so the caller
 * has to ask for the write explicitly rather than get one by forgetting a flag.
 */
export async function runUrlRewrite(input: {
  resourceUuid: string;
  fromUrl: string;
  toUrl: string;
  apply?: boolean;
  timeoutMs?: number;
}): Promise<RunUrlRewriteResult> {
  const pairs = buildReplacementPairs(input.fromUrl, input.toUrl);
  const base = { dryRun: input.apply !== true, tables: [], rowsChanged: 0, skippedUnserializable: 0, pairs };

  if (pairs.length === 0) {
    // Same host and scheme: nothing to do, and saying so beats reporting a
    // successful rewrite of zero rows as though work happened.
    return { ...base, ok: true, error: null };
  }
  if (!isSshHostConfigured()) {
    return { ...base, ok: false, error: "SSH host is not configured, so URLs cannot be rewritten." };
  }
  if (!input.resourceUuid.trim()) {
    return { ...base, ok: false, error: "This app is not linked to a Coolify resource." };
  }

  const payloadJson = JSON.stringify({ pairs, dryRun: input.apply !== true });
  const script = buildUrlRewriteScript({ resourceUuid: input.resourceUuid, payloadJson });

  // Generous: a large site walks tens of thousands of rows, and a rewrite killed
  // half way through is the one outcome worse than a slow one.
  const run = await runHostScript(script, { timeoutMs: input.timeoutMs ?? 240_000 });
  if (run.transportError) {
    return { ...base, ok: false, error: run.transportError };
  }

  const marker = /^JONGO_RESULT=(.+)$/m.exec(run.stdout);
  const result = marker?.[1]?.trim();
  if (result === "deferred_deploy_in_progress") {
    return { ...base, ok: false, error: "A deploy is building on the host; the rewrite was not run." };
  }
  if (result === "no_containers" || result === "no_wordpress_container") {
    return { ...base, ok: false, error: "No running WordPress container was found for this app." };
  }
  if (result !== "ok") {
    const detail = run.stderr.trim().slice(0, 300);
    return { ...base, ok: false, error: `URL rewrite did not run${detail ? `: ${detail}` : "."}` };
  }

  const report = parseRewriteReport(run.stdout.slice((marker?.index ?? 0) + (marker?.[0].length ?? 0)));
  return { ...report, pairs };
}
