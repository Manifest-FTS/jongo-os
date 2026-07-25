import { describe, expect, it } from "vitest";
import { shouldAlertOnBackupFailure, buildBackupFailureEmail } from "./backup-alert";

const now = new Date("2026-07-25T12:00:00Z");

describe("shouldAlertOnBackupFailure", () => {
  it("alerts on the first scheduled failure", () => {
    const d = shouldAlertOnBackupFailure({ status: "failed", trigger: "scheduled", lastAlertAt: null, now });
    expect(d.alert).toBe(true);
    expect(d.reason).toBe("first_failure");
  });

  it("does not alert on success", () => {
    expect(
      shouldAlertOnBackupFailure({ status: "success", trigger: "scheduled", lastAlertAt: null, now }).alert
    ).toBe(false);
  });

  it("stays quiet for on-demand failures, which the user already sees", () => {
    const d = shouldAlertOnBackupFailure({ status: "failed", trigger: "manual", lastAlertAt: null, now });
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("on_demand_failure_is_already_visible");
  });

  it("suppresses a repeat failure inside the cooldown so nightly breakage is not nightly email", () => {
    const d = shouldAlertOnBackupFailure({
      status: "failed",
      trigger: "scheduled",
      lastAlertAt: new Date("2026-07-25T02:00:00Z"),
      now
    });
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("within_cooldown");
  });

  it("alerts again once the cooldown has elapsed", () => {
    const d = shouldAlertOnBackupFailure({
      status: "failed",
      trigger: "scheduled",
      lastAlertAt: new Date("2026-07-23T02:00:00Z"),
      now
    });
    expect(d.alert).toBe(true);
    expect(d.reason).toBe("cooldown_elapsed");
  });

  it("treats an unparseable last-alert timestamp as never alerted rather than skipping", () => {
    const d = shouldAlertOnBackupFailure({
      status: "failed",
      trigger: "scheduled",
      lastAlertAt: "garbage",
      now
    });
    expect(d.alert).toBe(true);
  });
});

describe("buildBackupFailureEmail", () => {
  it("points at the last good backup when one exists", () => {
    const m = buildBackupFailureEmail({
      siteName: "wptest",
      siteUrl: "https://os.example/apps/wptest/backups",
      failedAt: now,
      error: "no containers found",
      lastSuccessAt: new Date("2026-07-24T02:00:00Z")
    });
    expect(m.subject).toBe("Backup failed for wptest");
    expect(m.text).toContain("no containers found");
    expect(m.text).toContain("2026-07-24 02:00 UTC");
    expect(m.text).toContain("restore from that one");
  });

  it("says plainly when there is no restore point at all", () => {
    const m = buildBackupFailureEmail({
      siteName: "wptest",
      siteUrl: "https://os.example/apps/wptest/backups",
      failedAt: now,
      error: null,
      lastSuccessAt: null
    });
    expect(m.text).toContain("no restore point");
    expect(m.text).toContain("Reason: not reported.");
  });
});
