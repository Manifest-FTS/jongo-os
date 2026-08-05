/**
 * Rehearsing a backup: restoring it somewhere harmless to find out whether it
 * would actually work.
 *
 * The platform already had a restore test, but it verifies COOLIFY's dumps in
 * /data/coolify/backups/databases — a different artifact from the restic
 * snapshots the SiteBackup catalogue advertises as restorable. So the thing the
 * UI offers a Restore button for was the one thing nothing ever proved.
 *
 * That gap is how a backup pipeline ends up confidently wrong. Every signal the
 * system had said "healthy" while `pg_dump` without --clean and `psql` without
 * ON_ERROR_STOP meant a restore could exit 0 having applied nothing. A rehearsal
 * is the only check that would have caught it, because it is the only one that
 * replays the real artifact through the real code path.
 *
 * A rehearsal never touches live data: it replays into a throwaway container
 * that is destroyed afterwards. That is what makes it safe to run unattended on
 * customer backups, which in turn is what makes "every backup is proven
 * restorable" a claim rather than a hope.
 */

export const DEFAULT_REHEARSAL_INTERVAL_DAYS = 7;

export type RehearsalCandidate = {
  /** Coolify resource uuid — what BackupRestoreVerification is keyed by. */
  resourceUuid: string;
  /** Site slug, for logs. */
  slug?: string;
  /** When this resource was last rehearsed; null when never. */
  lastVerifiedAt?: Date | string | null;
  /** The backup to rehearse: most recent restorable one. Null when none exists. */
  backupId?: string | null;
  snapshotId?: string | null;
};

/**
 * Which resources are due a rehearsal, least-recently-verified first.
 *
 * Never-verified sorts ahead of everything, because a resource nobody has ever
 * proven is a bigger unknown than one proven a fortnight ago.
 *
 * Candidates with nothing to rehearse are dropped rather than ordered last: a
 * site with no restorable backup is a real problem, but it is the backup
 * pipeline's problem, and surfacing it as a failed rehearsal would blame the
 * wrong thing.
 */
export function orderDueRehearsals(
  candidates: RehearsalCandidate[],
  opts: { now?: Date; intervalDays?: number } = {}
): RehearsalCandidate[] {
  const now = (opts.now ?? new Date()).getTime();
  const intervalMs = positiveOr(opts.intervalDays, DEFAULT_REHEARSAL_INTERVAL_DAYS) * 24 * 60 * 60 * 1000;

  return candidates
    .filter((c) => {
      if (!c.resourceUuid?.trim()) return false;
      if (!c.backupId?.trim() || !c.snapshotId?.trim()) return false;
      const last = toTime(c.lastVerifiedAt);
      if (last === null) return true; // never rehearsed
      return now - last >= intervalMs;
    })
    .sort((a, b) => (toTime(a.lastVerifiedAt) ?? 0) - (toTime(b.lastVerifiedAt) ?? 0));
}

export type RehearsalVerdict = {
  pass: boolean;
  reason: "verified" | "snapshot_unreadable" | "no_dumps" | "replay_failed" | "restored_empty";
  /** One line for the operator. */
  message: string;
};

/**
 * Did the rehearsal prove the backup restorable?
 *
 * "Replayed without error" is not enough on its own — that is precisely the
 * assumption that let an empty restore look healthy. The dump must replay AND
 * the resulting database must hold tables.
 *
 * A snapshot containing no database dumps is NOT a failure: files-only
 * resources are legitimate and common. It is reported as "nothing to rehearse"
 * so it neither claims a pass it did not earn nor raises an alarm about a
 * backup that is fine.
 */
export function describeRehearsalOutcome(input: {
  /** Did restic read the snapshot out of offsite storage? */
  snapshotRestored: boolean;
  /** Database dumps found inside the snapshot. */
  dumpsFound: number;
  /** Dumps that replayed without error. */
  dumpsReplayed: number;
  /** Tables present across the throwaway databases afterwards. */
  tablesAfter: number;
}): RehearsalVerdict {
  if (!input.snapshotRestored) {
    return {
      pass: false,
      reason: "snapshot_unreadable",
      message:
        "The snapshot could not be read back from offsite storage, so this backup could not be restored if it were needed."
    };
  }

  if (count(input.dumpsFound) === 0) {
    // Files-only resources are legitimate; the snapshot itself read back fine,
    // which is the part this check can speak to.
    return {
      pass: true,
      reason: "no_dumps",
      message: "The snapshot read back cleanly. It holds no database dump, so there was nothing further to replay."
    };
  }

  if (count(input.dumpsReplayed) < count(input.dumpsFound)) {
    return {
      pass: false,
      reason: "replay_failed",
      message: `Only ${count(input.dumpsReplayed)} of ${count(input.dumpsFound)} database dumps in this backup could be replayed. It would not restore cleanly.`
    };
  }

  if (count(input.tablesAfter) === 0) {
    return {
      pass: false,
      reason: "restored_empty",
      message:
        "The database dumps replayed without error but produced no tables. This backup would restore an empty database."
    };
  }

  return {
    pass: true,
    reason: "verified",
    message: ""
  };
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
