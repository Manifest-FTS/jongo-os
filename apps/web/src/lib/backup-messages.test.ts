import { describe, expect, it } from "vitest";
import { describeBackupError } from "./backup-messages";

describe("describeBackupError", () => {
  it("returns null when there is no error", () => {
    expect(describeBackupError(null)).toBeNull();
    expect(describeBackupError(undefined)).toBeNull();
    expect(describeBackupError("   ")).toBeNull();
  });

  it("maps known backup codes to plain language", () => {
    const msg = describeBackupError("fail_no_db_container");
    expect(msg).toContain("database container");
    expect(msg).not.toContain("fail_no_db_container");
  });

  it("reassures that nothing changed on a failed restore", () => {
    expect(describeBackupError("fail_snapshot_not_wordpress")).toContain("untouched");
    expect(describeBackupError("fail_restic_restore")).toContain("untouched");
  });

  it("does not silently swallow unknown codes", () => {
    expect(describeBackupError("some_new_code")).toContain("some_new_code");
  });
});
