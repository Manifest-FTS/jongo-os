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
  /**
   * Elementor's generated CSS, under wp-content/uploads/elementor/css.
   *
   * Elementor compiles each page's styles to a file and serves that, so a
   * design change can be live in the database while every visitor still gets
   * the previously compiled stylesheet. `wp cache flush` does not touch it —
   * it is not the object cache — which is why a site could report a clean
   * flush and still render the old layout.
   */
  elementor?: CacheTargetStatus | null;
  /** A linked Redis object cache, flushed directly. */
  redis?: CacheTargetStatus | null;
  /**
   * Cloudflare's edge cache.
   *
   * The three above all live inside the container. None of them reach a CDN, so
   * a site behind Cloudflare could report every local cache flushed while the
   * public URL kept serving a stale copy from the edge — which is the same
   * "reported success, page still stale" failure this module exists to prevent,
   * one layer further out.
   */
  cloudflare?: CacheTargetStatus | null;
};

export type CacheFlushReason =
  /** Something was cleared. */
  | "flushed"
  /** Something was cleared, but not everything that was tried. */
  | "flushed_partial"
  /** Nothing to clear — this site has no caching layer. Not a failure. */
  | "nothing_to_flush"
  /** There was a cache, and clearing it failed. */
  | "flush_failed";

export type CacheFlushOutcome = {
  /** True only when something was genuinely cleared. */
  flushed: boolean;
  /**
   * Lets the caller tell "nothing to do" apart from "it broke". Both leave
   * `flushed` false — neither may be shown as a success — but only one of them
   * is a problem, and rendering them identically makes a normal site look
   * broken.
   */
  reason: CacheFlushReason;
  /** Sentence for the operator. Never claims more than happened. */
  message: string;
  /** Per-target detail, for the expanded view. */
  details: Array<{ target: string; status: CacheTargetStatus }>;
};

const LABELS: Record<keyof CacheFlushInput, string> = {
  wpCli: "object cache",
  fileCache: "page cache files",
  elementor: "Elementor CSS",
  redis: "Redis",
  cloudflare: "Cloudflare edge cache"
};

/** Report order: innermost cache first, the CDN last. */
const TARGET_ORDER: Array<keyof CacheFlushInput> = [
  "wpCli",
  "fileCache",
  "elementor",
  "redis",
  "cloudflare"
];

export function describeCacheFlush(input: CacheFlushInput): CacheFlushOutcome {
  const details: Array<{ target: string; status: CacheTargetStatus }> = [];
  for (const key of TARGET_ORDER) {
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
        reason: "flush_failed",
        message: `The cache could not be flushed (${failedTargets.join(", ")} failed). Nothing was cleared.`,
        details
      };
    }
    return {
      flushed: false,
      // Deliberately NOT phrased as a failure. This site simply has no caching
      // layer installed, which is a normal way for a WordPress site to be, and
      // the caller renders it as a note rather than an error. It still is not a
      // success: reporting "flushed" here is the exact bug this replaced.
      reason: "nothing_to_flush",
      message:
        "Nothing to flush — this site has no caching plugin, object cache, Elementor CSS, Redis or Cloudflare zone.",
      details
    };
  }

  // Something worked. A partial failure still gets reported, because a page
  // that is still stale afterwards is explained by the part that failed.
  if (failedTargets.length > 0) {
    return {
      flushed: true,
      reason: "flushed_partial",
      message: `Flushed ${joinList(flushedTargets)}, but ${joinList(failedTargets)} could not be cleared.`,
      details
    };
  }

  return {
    flushed: true,
    reason: "flushed",
    message: `Flushed ${joinList(flushedTargets)}.`,
    details
  };
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
