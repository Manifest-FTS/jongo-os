/**
 * What did a cache flush actually flush?
 *
 * The Flush Cache button used to be `onClick={() => showSuccessToast("Cache
 * flush request queued.")}` — no request, no queue, no flush. It reported
 * success unconditionally, which is worse than a button that does nothing:
 * someone debugging a stale page would rule out caching on the strength of a
 * toast and go looking for the problem somewhere it isn't.
 *
 * So the rule here is that success has to be earned by at least one cache
 * actually being cleared, and the message names which. A WordPress site can
 * hold its cache in several places and any of them may legitimately be absent —
 * no wp-cli in the image, no file cache plugin, no Redis — but if ALL of them
 * are absent then nothing was flushed, and saying otherwise is the original bug
 * wearing a different hat.
 */

export type CacheTargetStatus = "flushed" | "absent" | "failed";

export type CacheFlushInput = {
  /** `wp cache flush` — the object cache, when wp-cli exists in the container. */
  wpCli?: CacheTargetStatus | null;
  /** Files under wp-content/cache, written by page cache plugins. */
  fileCache?: CacheTargetStatus | null;
  /** A linked Redis object cache, flushed directly. */
  redis?: CacheTargetStatus | null;
};

export type CacheFlushOutcome = {
  /** True only when something was genuinely cleared. */
  flushed: boolean;
  /** Sentence for the operator. Never claims more than happened. */
  message: string;
  /** Per-target detail, for the expanded view. */
  details: Array<{ target: string; status: CacheTargetStatus }>;
};

const LABELS: Record<keyof CacheFlushInput, string> = {
  wpCli: "object cache",
  fileCache: "page cache files",
  redis: "Redis"
};

export function describeCacheFlush(input: CacheFlushInput): CacheFlushOutcome {
  const details: Array<{ target: string; status: CacheTargetStatus }> = [];
  for (const key of ["wpCli", "fileCache", "redis"] as Array<keyof CacheFlushInput>) {
    const status = input[key];
    if (status === "flushed" || status === "absent" || status === "failed") {
      details.push({ target: LABELS[key], status });
    }
  }

  const flushedTargets = details.filter((d) => d.status === "flushed").map((d) => d.target);
  const failedTargets = details.filter((d) => d.status === "failed").map((d) => d.target);

  if (flushedTargets.length === 0) {
    // Nothing cleared. Distinguish "tried and failed" from "there was nothing
    // here to clear" — they call for completely different next steps.
    if (failedTargets.length > 0) {
      return {
        flushed: false,
        message: `The cache could not be flushed (${failedTargets.join(", ")} failed). Nothing was cleared.`,
        details
      };
    }
    return {
      flushed: false,
      message:
        "No cache was found to flush. This site has no object cache, no page cache files and no Redis, so there was nothing to clear.",
      details
    };
  }

  // Something worked. A partial failure still gets reported, because a page
  // that is still stale afterwards is explained by the part that failed.
  if (failedTargets.length > 0) {
    return {
      flushed: true,
      message: `Flushed ${joinList(flushedTargets)}, but ${joinList(failedTargets)} could not be cleared.`,
      details
    };
  }

  return {
    flushed: true,
    message: `Flushed ${joinList(flushedTargets)}.`,
    details
  };
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
