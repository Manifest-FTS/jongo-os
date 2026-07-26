/**
 * Work out, from an app's environment variables, whether it has a database and
 * whether that database is one we can back up.
 *
 * This decides whether an app is offered backups at all, so the two directions
 * are not equally bad. Wrongly saying "no database" hides backups from an app
 * that has data and tells its owner there is nothing to lose — silent data
 * loss. Wrongly saying "has a database" produces a visible failed backup.
 * The rules below are therefore biased toward finding data.
 *
 * The previous detector matched only five exact URL names, which missed:
 *   - POSTGRES_PRISMA_URL (contains POSTGRES and URL, but is not POSTGRES_URL)
 *   - host-style config: POSTGRES_HOST / DB_HOST plus separate credentials,
 *     with no URL variable at all — an app wired this way to an internal
 *     database would silently have had no backups
 *   - managed providers identified only by their own markers, e.g. an app with
 *     just NEXT_PUBLIC_SUPABASE_URL, which was reported as having no data when
 *     all of its data is in Supabase
 */

export type DatabaseEnvKind = "internal" | "external" | "none";

export type DatabaseEnvDetection = {
  kind: DatabaseEnvKind;
  /** Coolify resource uuids we could back up. Only set for `internal`. */
  internalHosts: string[];
  /** First external host or provider seen, for honest messaging. */
  externalHost?: string;
};

/**
 * Coolify addresses an internal resource by a bare uuid-like token. Requiring
 * that shape, rather than merely "has no dot", keeps values like `localhost`
 * or a generic `db` from being mistaken for a backupable resource — which
 * would promise a backup that could only fail.
 */
const INTERNAL_HOST = /^[a-z0-9]{20,}$/;

/** Engines the backup script can actually dump. Redis is deliberately absent:
 *  claiming a backup we cannot take produces an empty capture. */
const URL_KEY = /^(?!REDIS)[A-Z0-9_]*(DATABASE|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|DB)[A-Z0-9_]*_(URL|URI)$/;
const HOST_KEY = /^(?!REDIS)[A-Z0-9_]*(POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|MONGO|DB)[A-Z0-9_]*_(HOST|HOSTNAME)$/;
/** Managed providers: data exists, but not somewhere we can reach. */
const MANAGED_MARKER = /SUPABASE|PLANETSCALE|NEON_|TURSO|ATLAS_URI|MONGODB_ATLAS|UPSTASH/;

function hostFromUrl(value: string): string {
  const afterCredentials = value.match(/@([^:/?\s]+)/);
  if (afterCredentials) return afterCredentials[1];
  // Scheme with no credentials, e.g. postgres://my-host:5432/db
  const schemeOnly = value.match(/^[a-zA-Z+]+:\/\/([^:/?\s]+)/);
  return schemeOnly ? schemeOnly[1] : "";
}

export function detectDatabaseEnv(
  rows: Array<{ key?: unknown; name?: unknown; value?: unknown; real_value?: unknown }>
): DatabaseEnvDetection {
  const internal = new Set<string>();
  let externalHost: string | undefined;
  let managedSeen = false;

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.key ?? row?.name ?? "").trim().toUpperCase();
    if (!key) continue;
    const value = String(row?.value ?? row?.real_value ?? "").trim();

    if (MANAGED_MARKER.test(key)) {
      managedSeen = true;
    }

    let host = "";
    if (URL_KEY.test(key)) {
      host = hostFromUrl(value);
    } else if (HOST_KEY.test(key)) {
      // Host-style config puts the host in the value directly.
      host = value.split("/")[0].split(":")[0];
    }

    if (!host) continue;

    if (INTERNAL_HOST.test(host)) {
      internal.add(host);
    } else if (host.includes(".") && !externalHost) {
      externalHost = host;
    }
  }

  // An internal database wins: it is the one we can actually capture, even if
  // the app also talks to something external.
  if (internal.size > 0) {
    return { kind: "internal", internalHosts: Array.from(internal) };
  }
  if (externalHost) {
    return { kind: "external", internalHosts: [], externalHost };
  }
  if (managedSeen) {
    // Provider markers with no connection string still mean the app's data
    // lives somewhere real. Saying "no data" here is the harmful direction.
    return { kind: "external", internalHosts: [], externalHost: "a managed database provider" };
  }
  return { kind: "none", internalHosts: [] };
}
