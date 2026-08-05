/**
 * What kind of app is this, and what should its backup say it captured?
 *
 * The backup pipeline used to be WordPress with escape hatches: the resource
 * type was decided by `wpVersion ? "wordpress" : …`, and the only content
 * metrics that existed were posts/pages/plugins/comments. Every additional
 * stack meant another column on SiteBackup and another branch in the panel.
 *
 * So classification and presentation move here, behind one rule per stack.
 * Adding Nuxt is a STACKS entry and a test, not a migration.
 *
 * The host-side script deliberately does not do this. It gathers raw markers —
 * container names, image refs, framework files it found — and posts them; the
 * decision is made here, where it can be unit tested, instead of in bash on a
 * host whose tooling we do not control. That split is why this module takes
 * markers rather than talking to anything.
 */

export type StackId = "wordpress" | "nextjs" | "nuxt" | "node" | "database" | "service";

export type StackMarkers = {
  /** Container names belonging to the resource, e.g. ["wordpress-abc", "mariadb-abc"]. */
  containers?: string[] | null;
  /** WordPress signals. */
  wpVersion?: string | null;
  posts?: number | null;
  pages?: number | null;
  plugins?: number | null;
  comments?: number | null;
  /** Node signals, resolved from the app container's package.json / build output. */
  nodeFramework?: string | null;
  appName?: string | null;
  appVersion?: string | null;
  /** Shape of what was captured. */
  volumeCount?: number | null;
  databaseCount?: number | null;
  databaseTables?: number | null;
};

export type StackMetric = { label: string; value: string | number | null };

export type BackupContentSummary = {
  stack: StackId;
  /** Human name for the stack, shown as the row's caption. */
  label: string;
  metrics: StackMetric[];
};

const STACK_LABELS: Record<StackId, string> = {
  wordpress: "WordPress",
  nextjs: "Next.js",
  nuxt: "Nuxt",
  node: "Node app",
  database: "Database",
  service: "Service"
};

/**
 * Classify a resource from what the host actually found.
 *
 * Ordered most specific first. Framework detection beats the generic shapes
 * because a Next.js app with a Postgres database is a Next.js app, not a
 * "service" — the old volume/database arithmetic could only ever have said the
 * latter.
 */
export function detectStack(markers: StackMarkers): StackId {
  const containers = (markers.containers ?? []).filter(Boolean).map((c) => String(c).toLowerCase());

  if (nonEmpty(markers.wpVersion) || containers.some((c) => c.startsWith("wordpress-"))) {
    return "wordpress";
  }

  const framework = normalizeFramework(markers.nodeFramework);
  if (framework === "next") return "nextjs";
  if (framework === "nuxt") return "nuxt";
  if (framework) return "node";

  // No framework marker: fall back to the shape of what was captured. A
  // resource with databases and no file volumes is a standalone database.
  const volumes = count(markers.volumeCount);
  const databases = count(markers.databaseCount);
  if (databases > 0 && volumes === 0) return "database";

  return "service";
}

/**
 * The metrics a backup row should show for this stack.
 *
 * `formattedSize` is passed in rather than computed: byte formatting is a
 * presentation concern that already has one home in the panel, and duplicating
 * it here would be the same drift this module exists to prevent.
 */
export function summarizeBackupContent(
  markers: StackMarkers,
  options: { formattedSize?: string | null } = {}
): BackupContentSummary {
  const stack = detectStack(markers);
  const size = options.formattedSize ?? null;
  const volumes = numberOrNull(markers.volumeCount);
  const databases = numberOrNull(markers.databaseCount);

  if (stack === "wordpress") {
    return {
      stack,
      label: STACK_LABELS[stack],
      metrics: [
        { label: "Posts", value: numberOrNull(markers.posts) },
        { label: "Pages", value: numberOrNull(markers.pages) },
        { label: "Plugins", value: numberOrNull(markers.plugins) },
        { label: "Comments", value: numberOrNull(markers.comments) },
        { label: "WP Version", value: nonEmpty(markers.wpVersion) ? String(markers.wpVersion) : null }
      ]
    };
  }

  if (stack === "nextjs" || stack === "nuxt" || stack === "node") {
    return {
      stack,
      label: STACK_LABELS[stack],
      metrics: [
        { label: "Version", value: nonEmpty(markers.appVersion) ? String(markers.appVersion) : null },
        { label: volumes === 1 ? "Volume" : "Volumes", value: volumes },
        { label: databases === 1 ? "Database" : "Databases", value: databases },
        { label: "Tables", value: numberOrNull(markers.databaseTables) },
        { label: "Size", value: size }
      ]
    };
  }

  if (stack === "database") {
    return {
      stack,
      label: STACK_LABELS[stack],
      metrics: [
        { label: databases === 1 ? "Database" : "Databases", value: databases },
        { label: "Tables", value: numberOrNull(markers.databaseTables) },
        { label: "Size", value: size }
      ]
    };
  }

  return {
    stack,
    label: STACK_LABELS[stack],
    metrics: [
      { label: volumes === 1 ? "Volume" : "Volumes", value: volumes },
      { label: databases === 1 ? "Database" : "Databases", value: databases },
      { label: "Size", value: size }
    ]
  };
}

/**
 * Paths never worth capturing, whatever the stack.
 *
 * Applied as one superset rather than per-stack, because excludes have to be
 * decided before restic runs and detection only completes afterwards. That is
 * safe precisely because every entry is regenerable build or cache output — the
 * cost of excluding a Next.js cache from a WordPress site is nothing.
 */
export const BACKUP_EXCLUDES: readonly string[] = [
  // WordPress
  "**/wp-content/cache",
  "**/wp-content/*cache*/**",
  "**/wp-content/upgrade",
  // Node / JS build output and caches
  "**/node_modules/.cache",
  "**/.next/cache",
  "**/.nuxt/cache",
  "**/.turbo",
  "**/.parcel-cache",
  "**/.vite",
  // Generic
  "**/tmp/cache",
  "**/*.log"
];

/**
 * Normalize a framework marker to a known id.
 *
 * Returns "" for anything unrecognised, which the caller reads as "not a
 * framework we know" rather than as "not a node app" — an unknown-but-present
 * marker still classifies as a generic node app.
 */
function normalizeFramework(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "next" || raw === "nextjs" || raw === "next.js") return "next";
  if (raw === "nuxt" || raw === "nuxtjs" || raw === "nuxt.js") return "nuxt";
  return raw;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
