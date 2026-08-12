/**
 * Noticing that a Coolify resource has been deleted, within minutes.
 *
 * The webhook endpoint applies a deletion safely and idempotently, but nothing
 * calls it: Coolify has no deletion event to send. So the trigger has to be
 * discovered rather than received, and the only authoritative source for "does
 * this resource still exist" is Coolify's own resource index.
 *
 * Polling that index is cheap — one call per tick against a 200/min budget — and
 * it is immune to the churn that makes container events useless here: Coolify
 * destroys and recreates containers on every ordinary deploy, so a container
 * `destroy` event says nothing about whether the resource was deleted.
 *
 * The danger is the opposite of the reconciler's. The reconciler waits seven days
 * and risks being too slow; this acts in minutes and risks archiving a live app
 * because one API call misbehaved. Four guards, in order of how often they save
 * you:
 *
 *   1. A failed or untrusted poll is discarded entirely — no streaks advance, so
 *      an outage cannot accumulate into a deletion.
 *   2. A uuid must have been missing for a CONFIRMATION WINDOW, tracked in
 *      Site.resourceMissingSince so it survives a restart. One absence is a
 *      blip; still absent minutes later is a fact.
 *   3. A poll whose resource count collapsed against the last good one is not
 *      trusted at all — the same reasoning as shouldAbortArchiveBatch, which
 *      refuses a batch when too much of the fleet looks deleted at once.
 *   4. Only uuids previously SEEN present can go missing. Something never
 *      observed cannot be reported as deleted.
 *
 * Whatever survives all four is handed to the webhook, which remains the single
 * place a deletion is applied — idempotent, throttled and logged.
 */

/** Minutes a resource must stay missing before the fast path acts. */
export const DEFAULT_CONFIRM_MINUTES = 3;
export const DEFAULT_MAX_DROP_FRACTION = 0.25;

export type PollTrust = { trust: boolean; reason: string };

/**
 * Whether a poll's resource list is believable enough to compare against.
 *
 * An empty list is never trusted: it is what a broken token, a 429, or a
 * half-written response looks like, and it would otherwise mean "every app was
 * deleted".
 */
export function shouldTrustPoll(input: {
  currentCount: number;
  lastGoodCount: number | null;
  maxDropFraction?: number;
}): PollTrust {
  if (input.currentCount <= 0) {
    return { trust: false, reason: "poll returned no resources" };
  }
  if (input.lastGoodCount === null) {
    return { trust: true, reason: "first_poll" };
  }
  if (input.lastGoodCount <= 0) {
    return { trust: true, reason: "no_baseline" };
  }

  const dropped = input.lastGoodCount - input.currentCount;
  if (dropped <= 0) {
    return { trust: true, reason: "no_drop" };
  }

  const fraction = dropped / input.lastGoodCount;
  const maxDropFraction = input.maxDropFraction ?? DEFAULT_MAX_DROP_FRACTION;
  if (fraction > maxDropFraction) {
    return {
      trust: false,
      reason: `resource count fell from ${input.lastGoodCount} to ${input.currentCount} (${Math.round(fraction * 100)}%)`
    };
  }

  return { trust: true, reason: "within_expected_drop" };
}

/**
 * Whether a resource has been missing long enough to act on.
 *
 * Uses Site.resourceMissingSince, which the reconciler already maintains, rather
 * than counting consecutive polls in memory. Two reasons: it survives a restart,
 * so a redeploy cannot reset a conclusion halfway; and it means the fast path and
 * the seven-day path read the same field, so they can never disagree about when a
 * resource went away.
 *
 * The window is minutes, not days. That is the whole point of this path — but it
 * is why the trust guard above matters so much more here than it does for the
 * reconciler.
 */
export function isDeletionConfirmed(input: {
  missingSince: Date | string | null | undefined;
  now?: Date;
  confirmMinutes?: number;
}): { confirmed: boolean; reason: "not_missing" | "unreadable_timestamp" | "within_window" | "confirmed"; ageMinutes: number } {
  if (!input.missingSince) return { confirmed: false, reason: "not_missing", ageMinutes: 0 };

  const missingSince = input.missingSince instanceof Date ? input.missingSince : new Date(input.missingSince);
  if (Number.isNaN(missingSince.getTime())) {
    // Never treat an unreadable timestamp as "long ago".
    return { confirmed: false, reason: "unreadable_timestamp", ageMinutes: 0 };
  }

  const now = input.now ?? new Date();
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - missingSince.getTime()) / 60_000));
  const confirmMinutes = input.confirmMinutes ?? DEFAULT_CONFIRM_MINUTES;

  return ageMinutes >= confirmMinutes
    ? { confirmed: true, reason: "confirmed", ageMinutes }
    : { confirmed: false, reason: "within_window", ageMinutes };
}
