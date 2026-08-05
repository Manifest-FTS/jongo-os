/**
 * When is a backup or restore that still says "running" actually dead?
 *
 * Both jobs are detached children of the web process (`spawn(..., detached`),
 * and the only thing that ever clears their `running` status is the callback
 * they post when they finish. A deploy, an OOM kill, or a dropped SSH session
 * therefore leaves the row running forever. That is not merely untidy:
 *
 *   - the create-backup route refuses to start a backup while one is running,
 *     so a single orphaned row silently ends scheduled backups for that site,
 *     permanently, while the UI keeps showing a backup in progress;
 *   - the app reports "backup in progress" for a job that died days ago, which
 *     is the same lie as reporting success.
 *
 * So a run that has outlived any plausible duration is marked failed. The
 * timeout is deliberately generous — several hours — because the cost of the
 * two mistakes is not symmetric: abandoning a live run mislabels a backup that
 * will still complete and record itself, while leaving a dead one in place
 * stops backups altogether.
 */

export const DEFAULT_STALE_RUN_HOURS = 6;

export type StaleRunDecision = {
  abandon: boolean;
  /** Whole hours the run has been going. 0 when the start time is unusable. */
  ageHours: number;
  reason: "running" | "stale" | "no_start_time" | "not_running";
};

export function decideStaleRun(input: {
  status: string | null | undefined;
  startedAt: Date | string | null | undefined;
  now: Date;
  staleAfterHours?: number;
}): StaleRunDecision {
  if (String(input.status ?? "").trim() !== "running") {
    return { abandon: false, ageHours: 0, reason: "not_running" };
  }

  const started = toDate(input.startedAt);
  if (!started) {
    // No usable start time means no way to tell a hung run from a fresh one.
    // Left alone rather than guessed at: the sweep runs hourly, and a row that
    // genuinely is stuck will be caught once a start time exists.
    return { abandon: false, ageHours: 0, reason: "no_start_time" };
  }

  const hours = Math.max(0, Math.floor((input.now.getTime() - started.getTime()) / 3_600_000));
  const limit = positiveOr(input.staleAfterHours, DEFAULT_STALE_RUN_HOURS);

  return hours >= limit
    ? { abandon: true, ageHours: hours, reason: "stale" }
    : { abandon: false, ageHours: hours, reason: "running" };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
