import { describe, expect, it } from "vitest";
import { describeBackupContent } from "./backup-content";

describe("describeBackupContent", () => {
  it("flags the real production case: one database, zero tables", () => {
    // joyfeed-app: scheduled backup reported success with a 643-byte dump of a
    // database that had no tables. Every other signal said healthy.
    const v = describeBackupContent({ volumeCount: 0, databaseCount: 1, databaseTables: 0 });
    expect(v.hasContent).toBe(false);
    expect(v.reason).toBe("empty_database");
    expect(v.detail).toMatch(/no data/i);
    // Must not read as a fault, or people learn to ignore backup warnings.
    expect(v.detail).toMatch(/not a fault/i);
  });

  it("treats a WordPress backup with files and tables as real content", () => {
    const v = describeBackupContent({ volumeCount: 1, databaseCount: 1, databaseTables: 12 });
    expect(v.hasContent).toBe(true);
    expect(v.reason).toBe("files_and_tables");
    expect(v.detail).toBe("");
  });

  it("counts files alone as content, even with no database", () => {
    const v = describeBackupContent({ volumeCount: 2, databaseCount: 0, databaseTables: 0 });
    expect(v.hasContent).toBe(true);
    expect(v.reason).toBe("files");
  });

  it("counts tables alone as content, for a standalone database", () => {
    const v = describeBackupContent({ volumeCount: 0, databaseCount: 1, databaseTables: 18 });
    expect(v.hasContent).toBe(true);
    expect(v.reason).toBe("tables");
  });

  it("does not retroactively condemn backups taken before table counting existed", () => {
    // null means "not measured", which is different from measured-as-zero.
    const v = describeBackupContent({ volumeCount: 0, databaseCount: 1, databaseTables: null });
    expect(v.hasContent).toBe(true);
    expect(v.reason).toBe("unknown");
  });

  it("reports a capture with nothing at all", () => {
    const v = describeBackupContent({ volumeCount: 0, databaseCount: 0, databaseTables: 0 });
    expect(v.hasContent).toBe(false);
    expect(v.detail).toMatch(/no files and no database/i);
  });

  it("tolerates undefined inputs without claiming emptiness", () => {
    expect(describeBackupContent({}).hasContent).toBe(true);
  });
});
