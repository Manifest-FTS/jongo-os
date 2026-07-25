import { describe, expect, it } from "vitest";
import { describeRestorability } from "./backup-restorability";

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
