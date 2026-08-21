import { describe, expect, it } from "vitest";
import { describeCacheFlush } from "./cache-flush";

describe("describeCacheFlush", () => {
  it("reports what was actually flushed", () => {
    const outcome = describeCacheFlush({ wpCli: "flushed", fileCache: "flushed", redis: "flushed" });
    expect(outcome.flushed).toBe(true);
    expect(outcome.message).toBe("Flushed object cache, page cache files and Redis.");
  });

  it("names a single flushed target without list punctuation", () => {
    const outcome = describeCacheFlush({ wpCli: "flushed", fileCache: "absent", redis: "absent" });
    expect(outcome.flushed).toBe(true);
    expect(outcome.message).toBe("Flushed object cache.");
  });

  it("joins two targets with 'and'", () => {
    const outcome = describeCacheFlush({ wpCli: "flushed", fileCache: "flushed", redis: "absent" });
    expect(outcome.message).toBe("Flushed object cache and page cache files.");
  });

  // The original bug: a success toast with nothing behind it.
  it("does NOT report success when nothing was flushed", () => {
    const outcome = describeCacheFlush({ wpCli: "absent", fileCache: "absent", redis: "absent" });
    expect(outcome.flushed).toBe(false);
    expect(outcome.reason).toBe("nothing_to_flush");
  });

  it("does not report success when every target failed", () => {
    const outcome = describeCacheFlush({ wpCli: "failed", fileCache: "failed", redis: "absent" });
    expect(outcome.flushed).toBe(false);
    expect(outcome.reason).toBe("flush_failed");
    expect(outcome.message).toContain("could not be flushed");
  });

  it("distinguishes 'nothing there' from 'tried and failed'", () => {
    // These call for completely different next steps, so they must not read
    // the same — and the caller renders only one of them as an error.
    const absent = describeCacheFlush({ wpCli: "absent", fileCache: "absent", redis: "absent" });
    const failed = describeCacheFlush({ wpCli: "failed", fileCache: "absent", redis: "absent" });
    expect(absent.message).not.toBe(failed.message);
    expect(absent.reason).toBe("nothing_to_flush");
    expect(failed.reason).toBe("flush_failed");
    expect(absent.flushed).toBe(false);
    expect(failed.flushed).toBe(false);
  });

  it("does not phrase a site with no caching layer as a failure", () => {
    // A stock WordPress install has no cache. Rendering that in red made a
    // perfectly healthy site look broken.
    const outcome = describeCacheFlush({ wpCli: "absent", fileCache: "absent", redis: "absent" });
    expect(outcome.message).not.toMatch(/fail|error|could not/i);
    expect(outcome.message).toContain("Nothing to flush");
  });

  it("tags the reason on every outcome so the caller never re-derives it", () => {
    expect(describeCacheFlush({ fileCache: "flushed" }).reason).toBe("flushed");
    expect(describeCacheFlush({ fileCache: "flushed", redis: "failed" }).reason).toBe("flushed_partial");
    expect(describeCacheFlush({}).reason).toBe("nothing_to_flush");
  });

  it("reports a partial failure alongside the success", () => {
    // A page still stale afterwards is explained by the part that failed, so
    // burying it under an unqualified success would recreate the original bug.
    const outcome = describeCacheFlush({ wpCli: "flushed", fileCache: "failed", redis: "absent" });
    expect(outcome.flushed).toBe(true);
    expect(outcome.message).toContain("Flushed object cache");
    expect(outcome.message).toContain("page cache files could not be cleared");
  });

  it("omits targets that were never probed", () => {
    const outcome = describeCacheFlush({ wpCli: "flushed" });
    expect(outcome.details).toHaveLength(1);
    expect(outcome.details[0]).toEqual({ target: "object cache", status: "flushed" });
  });

  it("ignores unrecognised status values rather than counting them", () => {
    const outcome = describeCacheFlush({ wpCli: "nonsense" as never, fileCache: "flushed" });
    expect(outcome.details).toHaveLength(1);
    expect(outcome.flushed).toBe(true);
  });

  it("treats an empty input as nothing flushed", () => {
    const outcome = describeCacheFlush({});
    expect(outcome.flushed).toBe(false);
    expect(outcome.details).toHaveLength(0);
  });
});

describe("describeCacheFlush with Cloudflare", () => {
  it("reports a real flush when only the CDN had anything to clear", () => {
    // The gardenstateequality.org case: all three container-local caches are
    // absent, so this used to report "nothing to flush" while Cloudflare was
    // still serving a stale page and only a manual dashboard purge could fix it.
    const outcome = describeCacheFlush({
      wpCli: "absent",
      fileCache: "absent",
      redis: "absent",
      cloudflare: "flushed"
    });
    expect(outcome.flushed).toBe(true);
    expect(outcome.reason).toBe("flushed");
    expect(outcome.message).toMatch(/Cloudflare edge cache/);
  });

  it("still says nothing-to-flush when the site has no caches at all", () => {
    const outcome = describeCacheFlush({
      wpCli: "absent",
      fileCache: "absent",
      redis: "absent",
      cloudflare: "absent"
    });
    expect(outcome.flushed).toBe(false);
    expect(outcome.reason).toBe("nothing_to_flush");
  });

  it("a site with no Cloudflare still reports its other three results", () => {
    // The requirement: an absent CDN must not turn a good local flush into a
    // failure, or hide what did happen.
    const outcome = describeCacheFlush({
      wpCli: "flushed",
      fileCache: "flushed",
      redis: "absent",
      cloudflare: "absent"
    });
    expect(outcome.flushed).toBe(true);
    expect(outcome.reason).toBe("flushed");
    expect(outcome.details.map((d) => d.target)).toContain("Cloudflare edge cache");
  });

  it("surfaces a failed purge as partial, because the page may still be stale", () => {
    const outcome = describeCacheFlush({
      wpCli: "flushed",
      fileCache: "absent",
      redis: "absent",
      cloudflare: "failed"
    });
    expect(outcome.flushed).toBe(true);
    expect(outcome.reason).toBe("flushed_partial");
    expect(outcome.message).toMatch(/Cloudflare edge cache could not be cleared/);
  });

  it("is a hard failure when the CDN was the only target and it failed", () => {
    const outcome = describeCacheFlush({
      wpCli: "absent",
      fileCache: "absent",
      redis: "absent",
      cloudflare: "failed"
    });
    expect(outcome.flushed).toBe(false);
    expect(outcome.reason).toBe("flush_failed");
  });

  it("lists the CDN last, outermost cache after the local ones", () => {
    const outcome = describeCacheFlush({
      wpCli: "flushed",
      fileCache: "flushed",
      redis: "flushed",
      cloudflare: "flushed"
    });
    expect(outcome.details.map((d) => d.target)).toEqual([
      "object cache",
      "page cache files",
      "Redis",
      "Cloudflare edge cache"
    ]);
  });
});
