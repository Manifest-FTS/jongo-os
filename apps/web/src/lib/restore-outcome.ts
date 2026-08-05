/**
 * Did a restore actually put the data back?
 *
 * The restore script used to answer this with "the commands exited 0", which is
 * not the same question. Plain `pg_dump` emits no DROP statements and `psql`
 * without ON_ERROR_STOP reports each "already exists" and carries on, so
 * replaying a dump into a database that still held the old tables logged one
 * error per object, exited 0, and was recorded as a successful restore that had
 * changed nothing. Someone rolling back a bad deploy would have been told they
 * were back on yesterday's data while looking at today's.
 *
 * The dump flags are fixed now, but a restore is the one operation where the
 * cost of believing a false success is unbounded, so the outcome is judged on
 * evidence collected AFTER the replay: how many tables the live databases
 * actually hold.
 *
 * Deliberately NOT an equality check against the recorded table count. The
 * backup counts `CREATE TABLE` statements in the dump; this counts live base
 * tables. Views, stored code and partitioned tables make the two legitimately
 * disagree, and a false "your restore failed" would send someone chasing a
 * problem that is not there — or worse, restoring again. Only the unambiguous
 * case fails: the backup held tables and the databases came back with none.
 */

export type RestoreOutcomeReason =
  | "restored"
  | "script_failed"
  | "nothing_applied"
  | "databases_empty";

export type RestoreOutcome = {
  ok: boolean;
  reason: RestoreOutcomeReason;
  /** End-user copy. Empty when the restore succeeded. */
  message: string;
};

export function describeRestoreOutcome(input: {
  /** RESULT= line from the script; "ok" when it ran to completion. */
  result: string | null | undefined;
  volumesRestored: number | null | undefined;
  databasesRestored: number | null | undefined;
  /** Live base tables counted after the replay. Null when not measured. */
  tablesAfter: number | null | undefined;
  /** Tables the backup recorded capturing. 0/null when unknown. */
  expectedTables: number | null | undefined;
}): RestoreOutcome {
  const volumes = toCount(input.volumesRestored);
  const databases = toCount(input.databasesRestored);
  const tablesAfter = toCountOrNull(input.tablesAfter);
  const expected = toCount(input.expectedTables);

  if (String(input.result ?? "").trim() !== "ok") {
    return {
      ok: false,
      reason: "script_failed",
      message: "The restore did not complete. The site was left as it was and the safety snapshot is unused."
    };
  }

  // Some resources are files-only and some are database-only, so either alone
  // is a real restore — but neither means nothing happened.
  if (volumes === 0 && databases === 0) {
    return {
      ok: false,
      reason: "nothing_applied",
      message: "The restore ran but put nothing back — no files and no database were applied."
    };
  }

  // The case this check exists for. Only fires when the backup is known to have
  // held tables and the measurement came back as a hard zero; an unmeasured
  // restore (null) is not evidence of anything.
  if (databases > 0 && expected > 0 && tablesAfter === 0) {
    return {
      ok: false,
      reason: "databases_empty",
      message:
        "The restore reported applying the database, but the database is empty afterwards. The site has NOT been rolled back — use the safety snapshot before making further changes."
    };
  }

  return { ok: true, reason: "restored", message: "" };
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function toCountOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
