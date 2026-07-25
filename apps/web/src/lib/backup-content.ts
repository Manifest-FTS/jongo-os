/**
 * Did this backup actually capture anything?
 *
 * Found in production: a scheduled backup of a non-WordPress app reported
 * success, "1 database", and a restorable snapshot — while the snapshot held a
 * 643-byte dump of an empty database. pg_dump of a database with no tables is
 * still valid and complete, so every signal the system had said "healthy".
 *
 * That is the most expensive kind of wrong. A failed backup is visible and gets
 * fixed; a successful backup of nothing quietly convinces someone they have a
 * restore point. So an empty capture is surfaced as its own state rather than
 * folded into success.
 *
 * Note this is NOT a failure: an app with a provisioned-but-unused database is
 * working exactly as intended, and calling it "failed" would train people to
 * ignore backup errors. It is reported as "nothing to capture yet".
 */

export type BackupContentVerdict = {
  /** True when the run captured real data. */
  hasContent: boolean;
  /** Distinguishes the reason for the UI. */
  reason: "files" | "tables" | "files_and_tables" | "empty_database" | "unknown";
  /** One line for the UI; empty when there is content. */
  detail: string;
};

export function describeBackupContent(input: {
  volumeCount?: number | null;
  databaseCount?: number | null;
  databaseTables?: number | null;
}): BackupContentVerdict {
  const volumes = numberOrNull(input.volumeCount);
  const databases = numberOrNull(input.databaseCount);
  const tables = numberOrNull(input.databaseTables);

  const hasFiles = (volumes ?? 0) > 0;
  const hasTables = (tables ?? 0) > 0;

  if (hasFiles && hasTables) {
    return { hasContent: true, reason: "files_and_tables", detail: "" };
  }
  if (hasFiles) {
    return { hasContent: true, reason: "files", detail: "" };
  }
  if (hasTables) {
    return { hasContent: true, reason: "tables", detail: "" };
  }

  // Backups taken before table counting existed report null, not 0. Treating
  // those as empty would retroactively mark good historical backups as hollow,
  // so they stay "unknown" and keep their existing presentation.
  if (tables === null) {
    return { hasContent: true, reason: "unknown", detail: "" };
  }

  if ((databases ?? 0) > 0) {
    return {
      hasContent: false,
      reason: "empty_database",
      detail:
        "This app's database has no tables yet, so this backup contains no data. It is not a fault — there is simply nothing to capture until the app stores something."
    };
  }

  return {
    hasContent: false,
    reason: "empty_database",
    detail: "This backup captured no files and no database content."
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
