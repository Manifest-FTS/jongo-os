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

// ---------------------------------------------------------------------------
// What a deferral means, and who (if anyone) should hear about it
// ---------------------------------------------------------------------------

/**
 * - app_stopped: the app has no running container. Nothing changes while it is
 *   stopped, so its last backup is still current: pause quietly, retry on the
 *   normal schedule, never email the owner about it.
 * - server_busy: another backup, a deploy, or a lock on the shared repository.
 *   A platform problem the client can't act on: retry next hour, and if it
 *   goes on past the limit, alert platform admins (once), not the owner.
 * - other: unknown reason. The original rule: escalate to a failure.
 */
export type DeferralKind = "app_stopped" | "server_busy" | "other";

export function classifyDeferral(token: string | null | undefined): DeferralKind {
  const value = String(token ?? "").trim();
  if (value === "deferred_no_containers") return "app_stopped";
  if (value === "deferred_backup_in_progress" || value === "deferred_repo_locked" || value === "deferred_deploy_in_progress") {
    return "server_busy";
  }
  return "other";
}

export type DeferralPlan =
  /** Drop the placeholder, make the site due again next hour. */
  | { action: "retry"; kind: DeferralKind }
  /** App stopped: drop the placeholder, keep the normal schedule, mark paused. */
  | { action: "pause"; kind: "app_stopped" }
  /** Busy for too long: retry next hour AND tell platform admins. */
  | { action: "retry_and_alert_admins"; kind: "server_busy"; reason: string; hoursSinceSuccess: number | null }
  /** Someone asked for this backup: say plainly why it didn't run (no email). */
  | { action: "report_to_requester"; kind: DeferralKind; message: string }
  /** Unknown and persistent: record a real failure, which alerts the team. */
  | { action: "escalate"; kind: "other"; reason: string };

export const DEFERRAL_MESSAGES: Record<Exclude<DeferralKind, "other">, string> = {
  app_stopped: "The app isn't running, so there was nothing new to back up. Start the app, then back it up again.",
  server_busy: "Another backup or a deploy was running on the server, so this one didn't start. Try again in a few minutes."
};

export function planDeferral(input: {
  token: string | null | undefined;
  /** 'scheduled' | 'manual' | 'promote' */
  trigger: string | null | undefined;
  lastSuccessAt: Date | string | null | undefined;
  now?: Date;
  maxDeferralHours?: number;
}): DeferralPlan {
  const kind = classifyDeferral(input.token);

  // A person is waiting on this one: a vanished row reads as "nothing happened".
  if (input.trigger && input.trigger !== "scheduled" && kind !== "other") {
    return { action: "report_to_requester", kind, message: DEFERRAL_MESSAGES[kind] };
  }

  if (kind === "app_stopped") return { action: "pause", kind };

  const decision = decideDeferral({ lastSuccessAt: input.lastSuccessAt, now: input.now, maxDeferralHours: input.maxDeferralHours });
  if (decision.action === "defer") return { action: "retry", kind };
  if (kind === "server_busy") {
    return { action: "retry_and_alert_admins", kind, reason: decision.reason, hoursSinceSuccess: decision.hoursSinceSuccess };
  }
  return { action: "escalate", kind: "other", reason: decision.reason };
}
