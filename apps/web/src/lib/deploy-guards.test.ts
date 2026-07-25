import { describe, expect, it } from "vitest";
import { getBackupReadiness } from "./deploy-guards";
import type { AppBackupInventory } from "./coolify";

function inventory(overrides: Partial<AppBackupInventory> = {}): AppBackupInventory {
  return {
    configured: false,
    schedules: [],
    recentExecutions: [],
    databaseCoverage: [],
    source: "live",
    checkedAt: new Date("2026-07-25T12:00:00Z").toISOString(),
    ...overrides
  } as AppBackupInventory;
}

describe("getBackupReadiness", () => {
  it("does not lock an app that has no databases at all", () => {
    // The live case: ~17 stateless apps were permanently deploy- and
    // staging-locked on a condition they can never satisfy, and told to go
    // configure a backup schedule that cannot exist.
    const r = getBackupReadiness(inventory({ note: "no_databases_in_environment" }), "uuid-1");
    expect(r.locked).toBe(false);
    expect(r.code).toBe("backups_not_applicable");
    expect(r.reason).toMatch(/no databases/i);
  });

  it("still locks a real app that has databases but no schedule", () => {
    // The guard must survive for the case it exists for.
    const r = getBackupReadiness(inventory({ note: "backups_not_configured" }), "uuid-1");
    expect(r.locked).toBe(true);
    expect(r.code).toBe("backups_not_configured");
  });

  it("still locks a configured app that has never produced a successful backup", () => {
    const r = getBackupReadiness(inventory({ configured: true, note: "backups_not_configured" }), "uuid-1");
    expect(r.locked).toBe(true);
    expect(r.code).toBe("no_successful_backup");
  });

  it("locks when telemetry is unavailable, which is a real unknown", () => {
    const r = getBackupReadiness(inventory({ source: "unavailable" }), "uuid-1");
    expect(r.locked).toBe(true);
    expect(r.code).toBe("backup_telemetry_unavailable");
  });

  it("locks when the app is not linked to a Coolify resource", () => {
    expect(getBackupReadiness(inventory(), undefined).locked).toBe(true);
    expect(getBackupReadiness(null, "uuid-1").locked).toBe(true);
  });

  it("treats no-databases as not applicable even before configured is evaluated", () => {
    // configured=false would otherwise short-circuit to a lock.
    const r = getBackupReadiness(
      inventory({ configured: false, note: "no_databases_in_environment" }),
      "uuid-1"
    );
    expect(r.code).toBe("backups_not_applicable");
    expect(r.locked).toBe(false);
  });
});
