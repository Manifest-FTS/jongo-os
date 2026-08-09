import { describe, expect, it } from "vitest";
import { getBackupReadiness, BACKUP_STALE_AFTER_HOURS } from "./deploy-guards";
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

describe("getBackupReadiness with Jongo's own backups", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  // The bug this fixes: Coolify cannot see backups for service-embedded
  // databases, so every WordPress app was permanently locked on "telemetry
  // unavailable" no matter how many successful Jongo backups existed.
  it("unlocks on a recent Jongo backup even when Coolify telemetry is unavailable", () => {
    const r = getBackupReadiness(null, "uuid-1", { lastSuccessAt: hoursAgo(2) });
    expect(r.locked).toBe(false);
    expect(r.code).toBe("ready");
    expect(r.hoursSinceSuccess).toBe(2);
  });

  it("locks when the only Jongo backup is beyond the stale window", () => {
    const r = getBackupReadiness(null, "uuid-1", { lastSuccessAt: hoursAgo(BACKUP_STALE_AFTER_HOURS + 24) });
    expect(r.locked).toBe(true);
    expect(r.code).toBe("backup_stale");
  });

  it("says the app has never been backed up, rather than blaming Coolify", () => {
    // The operator's next step is one button, not a support ticket about API scope.
    const r = getBackupReadiness(null, "uuid-1", { lastSuccessAt: null });
    expect(r.locked).toBe(true);
    expect(r.code).toBe("no_successful_backup");
    expect(r.reason).toContain("never been backed up");
    expect(r.nextStep).toContain("Backups tab");
  });

  it("falls back to the Coolify rule when no Jongo state is supplied", () => {
    // Existing callers must behave exactly as before.
    expect(getBackupReadiness(null, "uuid-1").code).toBe("backup_telemetry_unavailable");
  });

  it("ignores an unparseable timestamp rather than unlocking on it", () => {
    const r = getBackupReadiness(null, "uuid-1", { lastSuccessAt: "not a date" });
    expect(r.locked).toBe(true);
    expect(r.code).toBe("no_successful_backup");
  });
});
