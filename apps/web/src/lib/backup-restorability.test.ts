import { describe, expect, it } from "vitest";
import { describeDownloadability, describeRestorability } from "./backup-restorability";

describe("describeRestorability", () => {
  it("allows a successful backup that still has its snapshot", () => {
    const r = describeRestorability({ status: "success", resticSnapshotId: "b864c545" });
    expect(r.restorable).toBe(true);
    expect(r.reason).toBe("restorable");
  });

  it("refuses a retention-expired backup and says so rather than calling it failed", () => {
    const r = describeRestorability({ status: "pruned", resticSnapshotId: "b864c545" });
    expect(r.restorable).toBe(false);
    expect(r.reason).toBe("expired");
    expect(r.message).toMatch(/retention/i);
    expect(r.message).not.toMatch(/did not complete/i);
  });

  it("refuses a failed backup", () => {
    const r = describeRestorability({ status: "failed", resticSnapshotId: null });
    expect(r.restorable).toBe(false);
    expect(r.reason).toBe("failed");
  });

  it("refuses a backup that is still running", () => {
    const r = describeRestorability({ status: "running", resticSnapshotId: null });
    expect(r.restorable).toBe(false);
    expect(r.reason).toBe("in_progress");
  });

  it("refuses a success with no snapshot id, which has nothing to restore from", () => {
    const r = describeRestorability({ status: "success", resticSnapshotId: "" });
    expect(r.restorable).toBe(false);
    expect(r.reason).toBe("no_snapshot");
  });

  it("treats null/undefined status as not restorable", () => {
    expect(describeRestorability({ status: null, resticSnapshotId: "abc" }).restorable).toBe(false);
    expect(describeRestorability({ status: undefined, resticSnapshotId: "abc" }).restorable).toBe(false);
  });
});

describe("describeDownloadability", () => {
  it("allows a successful backup that still has its snapshot", () => {
    const r = describeDownloadability({ status: "success", resticSnapshotId: "d682f783" });
    expect(r.downloadable).toBe(true);
    expect(r.reason).toBe("restorable");
    expect(r.message).toBe("");
  });

  it("tracks describeRestorability's verdict exactly, so the two cannot drift", () => {
    const cases = [
      { status: "success", resticSnapshotId: "d682f783" },
      { status: "success", resticSnapshotId: null },
      { status: "pruned", resticSnapshotId: "d682f783" },
      { status: "failed", resticSnapshotId: "d682f783" },
      { status: "running", resticSnapshotId: null }
    ];
    for (const input of cases) {
      expect(describeDownloadability(input).downloadable).toBe(describeRestorability(input).restorable);
      expect(describeDownloadability(input).reason).toBe(describeRestorability(input).reason);
    }
  });

  it("talks about downloading, never about restoring", () => {
    for (const status of ["pruned", "failed", "running"]) {
      const r = describeDownloadability({ status, resticSnapshotId: null });
      expect(r.message).not.toMatch(/restor/i);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it("distinguishes an expired backup from a failed one", () => {
    expect(describeDownloadability({ status: "pruned", resticSnapshotId: "d682f783" }).message).toMatch(
      /retention/i
    );
    expect(describeDownloadability({ status: "failed", resticSnapshotId: null }).message).toMatch(
      /did not complete/i
    );
  });
});
