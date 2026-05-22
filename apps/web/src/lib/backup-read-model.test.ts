import { describe, expect, it } from "vitest";
import { buildBackupReadModelSnapshot, getBackupOffsiteStatus } from "./backup-read-model";

describe("getBackupOffsiteStatus", () => {
  it("returns unknown when offsite signal is not provided", () => {
    const status = getBackupOffsiteStatus([
      {
        id: "s1",
        resourceId: "db-1",
        resourceName: "db-1",
        resourceType: "database",
        enabled: true
      }
    ]);

    expect(status.label).toBe("Unknown");
    expect(status.tone).toBe("unknown");
  });

  it("returns configured when any schedule reports offsite enabled", () => {
    const status = getBackupOffsiteStatus([
      {
        id: "s1",
        resourceId: "db-1",
        resourceName: "db-1",
        resourceType: "database",
        enabled: true,
        offsiteEnabled: false
      },
      {
        id: "s2",
        resourceId: "db-2",
        resourceName: "db-2",
        resourceType: "database",
        enabled: true,
        offsiteEnabled: true
      }
    ]);

    expect(status.label).toBe("Configured");
    expect(status.tone).toBe("healthy");
  });

  it("returns local only when known schedules are all local", () => {
    const status = getBackupOffsiteStatus([
      {
        id: "s1",
        resourceId: "db-1",
        resourceName: "db-1",
        resourceType: "database",
        enabled: true,
        offsiteEnabled: false
      }
    ]);

    expect(status.label).toBe("Local only");
    expect(status.tone).toBe("degraded");
  });
});

describe("buildBackupReadModelSnapshot", () => {
  it("builds a stable database-layer snapshot", () => {
    const snapshot = buildBackupReadModelSnapshot({
      ownership: "Manifest FTS / Jongo Open Source",
      localStatus: "Not protected",
      schedules: []
    });

    expect(snapshot.layerType).toBe("Database");
    expect(snapshot.restoreScope).toBe("Database data only");
    expect(snapshot.stagingSafety).toBe("Not full clone-safe");
    expect(snapshot.ownership).toContain("Manifest FTS");
  });
});