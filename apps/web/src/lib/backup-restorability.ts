/**
 * The single rule for "can this catalogue row be restored?".
 *
 * Kept import-free and in one place because the rule is safety-critical and was
 * previously duplicated: the page decided whether to SHOW the restore action and
 * the API decided whether to ALLOW it. Duplicated rules drift, and the drift
 * here is either a dead button or an unguarded restore.
 *
 * A row is restorable only when the run succeeded AND the restic snapshot it
 * points at still exists. Retention flips successful rows to `pruned` once
 * `restic forget` removes the snapshot from Backblaze, so `pruned` is a
 * completed backup that is simply no longer recoverable — a distinction the
 * rejection message must make, or an expired backup reads as a failed one.
 */

export type RestorabilityReason =
  | "restorable"
  | "in_progress"
  | "failed"
  | "expired"
  | "no_snapshot";

export type Restorability = {
  restorable: boolean;
  reason: RestorabilityReason;
  /** End-user copy. Empty when restorable. */
  message: string;
};

export function describeRestorability(input: {
  status: string | null | undefined;
  resticSnapshotId: string | null | undefined;
}): Restorability {
  const status = String(input.status ?? "").trim();
  const snapshotId = String(input.resticSnapshotId ?? "").trim();

  if (status === "running") {
    return {
      restorable: false,
      reason: "in_progress",
      message: "This backup is still running. It can be restored once it finishes."
    };
  }
  if (status === "pruned") {
    return {
      restorable: false,
      reason: "expired",
      message:
        "This backup has passed its retention period and was removed from offsite storage, so it can no longer be restored."
    };
  }
  if (status !== "success") {
    return {
      restorable: false,
      reason: "failed",
      message: "This backup did not complete successfully and cannot be restored."
    };
  }
  if (!snapshotId) {
    // Succeeded but no snapshot id recorded: restoring would have nothing to
    // target, so refuse rather than launch a run that cannot work.
    return {
      restorable: false,
      reason: "no_snapshot",
      message: "This backup has no offsite snapshot recorded, so it cannot be restored."
    };
  }
  return { restorable: true, reason: "restorable", message: "" };
}

export type Downloadability = {
  downloadable: boolean;
  reason: RestorabilityReason;
  /** End-user copy. Empty when downloadable. */
  message: string;
};

/**
 * "Can this catalogue row be downloaded?" — deliberately the SAME predicate as
 * restorability, because the requirement is identical: the run succeeded and the
 * restic snapshot it points at still exists. Sharing `describeRestorability`
 * rather than restating the checks is the point of this module; a download that
 * disagreed with a restore about whether a snapshot exists is exactly the drift
 * this file was written to prevent.
 *
 * Only the copy differs. Reusing the restore wording would tell someone their
 * download failed because the backup "cannot be restored", which sends them
 * looking for a restore they never asked for.
 */
export function describeDownloadability(input: {
  status: string | null | undefined;
  resticSnapshotId: string | null | undefined;
}): Downloadability {
  const restorability = describeRestorability(input);
  if (restorability.restorable) {
    return { downloadable: true, reason: "restorable", message: "" };
  }

  const messages: Record<RestorabilityReason, string> = {
    restorable: "",
    in_progress: "This backup is still running. It can be downloaded once it finishes.",
    failed: "This backup did not complete successfully, so there is nothing to download.",
    expired:
      "This backup has passed its retention period and was removed from offsite storage, so it can no longer be downloaded.",
    no_snapshot: "This backup has no offsite snapshot recorded, so there is nothing to download."
  };

  return {
    downloadable: false,
    reason: restorability.reason,
    message: messages[restorability.reason]
  };
}
