/**
 * Human-readable messages for backup/restore failures.
 *
 * The backup and restore scripts report machine codes (e.g. `fail_no_db_container`).
 * Surfacing those raw to users is unhelpful and looks unfinished — this maps them
 * to plain language, and always says whether anything was changed.
 */

const MESSAGES: Record<string, string> = {
  // ── backup ──
  fail_no_wp_container:
    "Couldn't find this site's WordPress container — it may be stopped. Nothing was changed.",
  fail_no_db_container:
    "Couldn't find this site's database container. The backup did not run, and nothing was changed.",
  fail_no_files_volume:
    "Couldn't locate this site's files on disk. The backup did not run, and nothing was changed.",
  fail_dump:
    "The database export failed — the credentials may be wrong or the database unreachable. Nothing was changed.",
  fail_dump_empty:
    "The database export came back empty, so the backup was rejected rather than saved incomplete.",
  fail_no_b2_creds:
    "Backblaze credentials are missing on the server, so the backup couldn't be sent offsite.",
  fail_restic:
    "Uploading the backup to Backblaze failed. The site is unaffected — no backup was saved.",

  // ── restore ──
  fail_safety_snapshot:
    "Couldn't take a safety snapshot first, so the restore was cancelled. Your site is untouched.",
  fail_restic_restore:
    "Couldn't download this backup from Backblaze. Your site is untouched.",
  fail_no_files_in_snapshot:
    "This backup doesn't contain site files, so it can't be restored. Your site is untouched.",
  fail_snapshot_not_wordpress:
    "This backup didn't look like a WordPress site, so the restore was stopped as a safety check. Your site is untouched.",
  fail_file_copy:
    "Copying files back failed part-way. The site was restarted — check it, and use the safety snapshot to roll back if needed."
};

/**
 * Turn a script error code into something a customer can read.
 * Unknown codes fall through as-is so nothing is silently swallowed.
 */
export function describeBackupError(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.trim();
  if (!key) return null;
  return MESSAGES[key] ?? `The backup did not complete (${key}).`;
}
