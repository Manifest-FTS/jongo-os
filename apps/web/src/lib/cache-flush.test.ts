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
    expect(outcome.message).toContain("No cache was found to flush");
  });

  it("does not report success when every target failed", () => {
    const outcome = describeCacheFlush({ wpCli: "failed", fileCache: "failed", redis: "absent" });
    expect(outcome.flushed).toBe(false);
    expect(outcome.message).toContain("could not be flushed");
  });

  it("distinguishes 'nothing there' from 'tried and failed'", () => {
    // These call for completely different next steps, so they must not read
    // the same.
    const absent = describeCacheFlush({ wpCli: "absent", fileCache: "absent", redis: "absent" });
    const failed = describeCacheFlush({ wpCli: "failed", fileCache: "absent", redis: "absent" });
    expect(absent.message).not.toBe(failed.message);
    expect(absent.flushed).toBe(false);
    expect(failed.flushed).toBe(false);
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
