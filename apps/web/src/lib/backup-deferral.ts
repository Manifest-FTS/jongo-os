/**
 * When a deferred backup stops being polite and starts being a problem.
 *
 * A deferral means the run yielded before doing any work — to a deploy, to
 * another backup on the same host, or to a lock on the shared restic
 * repository. Nothing failed, so the placeholder row is dropped and the site
 * becomes due again on the next hourly pass. That is right for a TRANSIENT
 * collision, which is what these almost always are.
 *
 * It is wrong for a persistent one, and persistent ones exist:
 *
 * - a restic prune that was killed leaves a stale lock in the repository, and
 *   restic will not clear it on its own — every backup then defers, forever;
 * - a deploy that never finishes leaves the deploy guard permanently tripped.
 *
 * In both cases the site quietly stops being backed up. Nothing alerts on
 * that today, because backup alerting is event-based (`backup_failed`,
 * `backup_empty`, `rehearsal_failed`) and a deferral is deliberately not an
 * event. So the failure mode is silence: no backups, no errors, no page, and
 * a "last backup" date that just stops moving.
 *
 * This is the bound. Once a site has gone longer than the limit without a
 * SUCCESSFUL backup, a further deferral is escalated to a real failure, which
 * alerts. Politeness has a deadline.
 */

/** Default ceiling. Matches BackupRestoreVerification.rpoHours, which is the
 *  recovery-point objective the platform already states elsewhere: a day plus
 *  a couple of hours of slack for a nightly schedule that drifts. */
export const DEFAULT_MAX_DEFERRAL_HOURS = 26;

export type DeferralDecision =
  /** Transient: drop the placeholder row and let the next pass retry. */
  | { action: "defer"; hoursSinceSuccess: number | null }
  /** Persistent: record it as a failure so somebody is told. */
  | { action: "escalate"; hoursSinceSuccess: number | null; reason: string };

export function decideDeferral(input: {
  /** Completion time of the most recent successful backup for this site. */
  lastSuccessAt: Date | string | null | undefined;
  now?: Date;
  maxDeferralHours?: number;
}): DeferralDecision {
  const now = input.now ?? new Date();
  const limit =
    Number.isFinite(input.maxDeferralHours) && (input.maxDeferralHours as number) > 0
      ? (input.maxDeferralHours as number)
      : DEFAULT_MAX_DEFERRAL_HOURS;

  const parsed = input.lastSuccessAt ? new Date(input.lastSuccessAt) : null;
  const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  if (!valid) {
    // No successful backup has EVER been recorded. A site that has never once
    // been backed up and is now deferring is the worst case to hide, not the
    // safest: there is no restore point at all, so there is nothing for the
    // deferral to be protecting.
    return {
      action: "escalate",
      hoursSinceSuccess: null,
      reason: "no successful backup has been recorded for this app yet"
    };
  }

  const hours = (now.getTime() - valid.getTime()) / 3_600_000;
  // A clock skew that puts the last success in the future must not read as a
  // huge age and alert; treat it as fresh.
  const age = hours < 0 ? 0 : hours;

  if (age > limit) {
    return {
      action: "escalate",
      hoursSinceSuccess: age,
      reason: `no successful backup for ${Math.floor(age)}h (limit ${limit}h)`
    };
  }

  return { action: "defer", hoursSinceSuccess: age };
}

/** Reads the operator override, falling back to the default. */
export function resolveMaxDeferralHours(raw?: string | null): number {
  const value = Number((raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_DEFERRAL_HOURS;
}
