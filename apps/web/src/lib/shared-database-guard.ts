/**
 * Guard against a restore that silently overwrites another app's data.
 *
 * Several apps on this platform do not own their database — they point at a
 * standalone Coolify database that is ALSO registered as its own app, and
 * sometimes shared with further apps. Restoring the app therefore restores a
 * database somebody else depends on, with nothing in the UI to suggest it.
 *
 * The worst live example is the control plane: jongo-open-source's linked
 * database IS the jongo-os database. A well-meaning "roll back this app" would
 * roll back every site record, collaborator, and backup catalogue row on the
 * platform — including the row describing the restore in progress.
 *
 * So a shared-database restore is not blocked outright (it is sometimes exactly
 * what you want), but it must be named and acknowledged rather than discovered
 * afterwards.
 *
 * Import-free so the blast-radius calculation is unit tested directly.
 */

export type SiteRef = {
  id: string;
  slug: string;
  name: string;
  /** The Coolify resource this app maps to. */
  coolifyServiceUuid: string | null;
};

export type SharedDatabaseAssessment = {
  /** True when restoring would write to a database another app also depends on. */
  shared: boolean;
  /** Database resource uuids this restore would overwrite. */
  databaseUuids: string[];
  /** Other apps affected, excluding the one being restored. */
  affected: Array<{ id: string; slug: string; name: string; role: "owner" | "consumer" }>;
  /** True when the restore would overwrite the database backing jongo itself. */
  includesControlPlane: boolean;
  /** One line for the confirmation dialog. Empty when not shared. */
  warning: string;
};

export function assessSharedDatabaseRestore(input: {
  /** The app being restored. */
  site: SiteRef;
  /** Database resource uuids the restore will write to. */
  databaseUuids: string[];
  /** Every non-deleted app, used to find who else depends on those databases. */
  allSites: SiteRef[];
  /** uuid -> database uuids, for apps that merely link to a database. */
  linksBySiteId?: Record<string, string[]>;
  /** The database uuid backing jongo's own control plane, if known. */
  controlPlaneDatabaseUuid?: string | null;
}): SharedDatabaseAssessment {
  const dbUuids = Array.from(
    new Set(input.databaseUuids.map((u) => String(u ?? "").trim()).filter(Boolean))
  );

  if (dbUuids.length === 0) {
    return {
      shared: false,
      databaseUuids: [],
      affected: [],
      includesControlPlane: false,
      warning: ""
    };
  }

  const dbSet = new Set(dbUuids);
  const affected: SharedDatabaseAssessment["affected"] = [];
  const seen = new Set<string>();

  for (const other of input.allSites) {
    if (other.id === input.site.id) continue;

    // The database resource registered as an app in its own right.
    const uuid = String(other.coolifyServiceUuid ?? "").trim();
    if (uuid && dbSet.has(uuid)) {
      if (!seen.has(other.id)) {
        seen.add(other.id);
        affected.push({ id: other.id, slug: other.slug, name: other.name, role: "owner" });
      }
      continue;
    }

    // Another app that also points at one of these databases.
    const links = input.linksBySiteId?.[other.id] ?? [];
    if (links.some((l) => dbSet.has(String(l ?? "").trim()))) {
      if (!seen.has(other.id)) {
        seen.add(other.id);
        affected.push({ id: other.id, slug: other.slug, name: other.name, role: "consumer" });
      }
    }
  }

  const controlPlaneUuid = String(input.controlPlaneDatabaseUuid ?? "").trim();
  const includesControlPlane = Boolean(controlPlaneUuid) && dbSet.has(controlPlaneUuid);

  if (affected.length === 0 && !includesControlPlane) {
    return {
      shared: false,
      databaseUuids: dbUuids,
      affected: [],
      includesControlPlane: false,
      warning: ""
    };
  }

  const names = affected.map((a) => a.name || a.slug);
  const parts: string[] = [];

  if (includesControlPlane) {
    // Stated first and bluntly: this one can destroy the record of itself.
    parts.push(
      "This restore would overwrite the database that runs Jongo itself. " +
        "Every app, team member, and backup record on the platform would be rolled back to the time of this snapshot, including the record of this restore."
    );
  }

  if (names.length > 0) {
    parts.push(
      names.length === 1
        ? `This app shares its database with ${names[0]}, which would also be rolled back to this snapshot.`
        : `This app shares its database with ${names.length} other apps (${names.join(", ")}), which would also be rolled back to this snapshot.`
    );
  }

  return {
    shared: true,
    databaseUuids: dbUuids,
    affected,
    includesControlPlane,
    warning: parts.join(" ")
  };
}
