import { describe, expect, it } from "vitest";
import {
  buildBackupReadModelSnapshot,
  getBackupOffsiteStatus,
  getBackupRestoreVerification
} from "./backup-read-model";

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

describe("getBackupRestoreVerification", () => {
  const now = new Date("2026-07-18T00:00:00Z");

  it("reports 'never' when no restore test is recorded", () => {
    const v = getBackupRestoreVerification();
    expect(v.status).toBe("never");
    expect(v.tone).toBe("unknown");
  });

  it("reports 'verified' when the last test is within RPO", () => {
    const v = getBackupRestoreVerification({
      lastVerifiedAt: "2026-07-17T18:00:00Z", // 6h before now
      lastResult: "pass",
      rpoHours: 26,
      now
    });
    expect(v.status).toBe("verified");
    expect(v.tone).toBe("healthy");
    expect(v.ageHours).toBe(6);
  });

  it("reports 'stale' when the last verified restore is older than RPO", () => {
    const v = getBackupRestoreVerification({
      lastVerifiedAt: "2026-07-16T00:00:00Z", // 48h before now
      lastResult: "pass",
      rpoHours: 26,
      now
    });
    expect(v.status).toBe("stale");
    expect(v.tone).toBe("degraded");
    expect(v.ageHours).toBe(48);
  });

  it("reports 'failed' when the last restore test failed, regardless of age", () => {
    const v = getBackupRestoreVerification({
      lastVerifiedAt: "2026-07-17T23:00:00Z",
      lastResult: "fail",
      now
    });
    expect(v.status).toBe("failed");
    expect(v.tone).toBe("degraded");
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

  it("defaults restore verification to 'never' when none is supplied", () => {
    const snapshot = buildBackupReadModelSnapshot({
      ownership: "Manifest FTS",
      localStatus: "Not protected",
      schedules: []
    });
    expect(snapshot.restoreVerification.status).toBe("never");
  });
});