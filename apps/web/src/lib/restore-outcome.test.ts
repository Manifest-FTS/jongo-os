import { describe, expect, it } from "vitest";
import { describeRestoreOutcome } from "./restore-outcome";

const base = {
  result: "ok",
  volumesRestored: 1,
  databasesRestored: 1,
  tablesAfter: 42,
  expectedTables: 42
};

describe("describeRestoreOutcome", () => {
  it("accepts a restore that put files and a database back", () => {
    expect(describeRestoreOutcome(base)).toEqual({ ok: true, reason: "restored", message: "" });
  });

  it("accepts a files-only restore", () => {
    const outcome = describeRestoreOutcome({ ...base, databasesRestored: 0, tablesAfter: 0, expectedTables: 0 });
    expect(outcome.ok).toBe(true);
  });

  it("accepts a database-only restore", () => {
    const outcome = describeRestoreOutcome({ ...base, volumesRestored: 0 });
    expect(outcome.ok).toBe(true);
  });

  it("fails when the script did not run to completion", () => {
    const outcome = describeRestoreOutcome({ ...base, result: "fail_restic_restore" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("script_failed");
  });

  it("fails when nothing at all was applied", () => {
    const outcome = describeRestoreOutcome({ ...base, volumesRestored: 0, databasesRestored: 0 });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("nothing_applied");
  });

  // The regression this module exists for: psql exits 0 having applied nothing.
  it("fails when a database was 'restored' but is empty afterwards", () => {
    const outcome = describeRestoreOutcome({ ...base, tablesAfter: 0 });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("databases_empty");
    expect(outcome.message).toContain("safety snapshot");
  });

  it("does not fail a restore whose live table count merely differs", () => {
    // Views and stored code make dump CREATE TABLE counts and live base-table
    // counts legitimately disagree. Only a hard zero is a failure.
    const outcome = describeRestoreOutcome({ ...base, tablesAfter: 39, expectedTables: 42 });
    expect(outcome.ok).toBe(true);
  });

  it("does not fail when the table count was never measured", () => {
    const outcome = describeRestoreOutcome({ ...base, tablesAfter: null });
    expect(outcome.ok).toBe(true);
  });

  it("does not fail when the backup recorded no table count", () => {
    // Backups taken before table counting existed report nothing to compare to.
    const outcome = describeRestoreOutcome({ ...base, tablesAfter: 0, expectedTables: 0 });
    expect(outcome.ok).toBe(true);
  });

  it("treats an empty-string table count as unmeasured, not as zero", () => {
    const outcome = describeRestoreOutcome({ ...base, tablesAfter: "" as unknown as number });
    expect(outcome.ok).toBe(true);
  });
});
