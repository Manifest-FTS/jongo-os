import { describe, expect, it } from "vitest";
import {
  buildBackupEventEmail,
  collectSiteRecipients,
  isBackupEventNotified,
  type BackupEvent
} from "./backup-notify";

const at = new Date("2026-08-09T03:14:00Z");

describe("collectSiteRecipients", () => {
  it("includes the owner, org collaborators and app collaborators", () => {
    const r = collectSiteRecipients({
      ownerEmail: "owner@example.com",
      organizationCollaboratorEmails: ["orgadmin@example.com"],
      collaboratorEmails: ["dev@example.com"]
    });
    expect(r).toEqual(["owner@example.com", "orgadmin@example.com", "dev@example.com"]);
  });

  it("deduplicates the same person case-insensitively", () => {
    // The owner is very often also a collaborator; they must not be mailed twice.
    const r = collectSiteRecipients({
      ownerEmail: "Owner@Example.com",
      organizationCollaboratorEmails: ["owner@example.com"],
      collaboratorEmails: ["OWNER@EXAMPLE.COM", "dev@example.com"]
    });
    expect(r).toEqual(["Owner@Example.com", "dev@example.com"]);
  });

  it("drops empty, null and malformed addresses", () => {
    const r = collectSiteRecipients({
      ownerEmail: null,
      organizationCollaboratorEmails: ["", "   ", undefined, "not-an-email"],
      collaboratorEmails: ["ok@example.com"]
    });
    expect(r).toEqual(["ok@example.com"]);
  });

  it("returns an empty list when nobody is reachable", () => {
    expect(collectSiteRecipients({})).toEqual([]);
  });
});

describe("isBackupEventNotified", () => {
  it("has every lifecycle event switched on", () => {
    const events: BackupEvent[] = [
      "backup_started",
      "backup_succeeded",
      "backup_failed",
      "schedule_enabled",
      "schedule_disabled"
    ];
    for (const event of events) {
      expect(isBackupEventNotified(event)).toBe(true);
    }
  });
});

describe("buildBackupEventEmail", () => {
  const base = { siteName: "Acme Dental", siteUrl: "https://jongo.example/apps/acme/backups", at };

  it("names the site and links the backups tab on every event", () => {
    const events: BackupEvent[] = [
      "backup_started",
      "backup_succeeded",
      "backup_failed",
      "schedule_enabled",
      "schedule_disabled"
    ];
    for (const event of events) {
      const m = buildBackupEventEmail({ ...base, event });
      expect(m.subject).toContain("Acme Dental");
      expect(m.text).toContain(base.siteUrl);
    }
  });

  it("distinguishes a promote-triggered backup from a scheduled one", () => {
    // The reader needs to know why a backup they did not schedule appeared.
    expect(buildBackupEventEmail({ ...base, event: "backup_started", trigger: "promote" }).text)
      .toContain("before a promotion to production");
    expect(buildBackupEventEmail({ ...base, event: "backup_started", trigger: "scheduled" }).text)
      .toContain("automatic scheduled backup");
  });

  it("reports a human-readable size on success", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_succeeded", sizeBytes: 5 * 1024 * 1024 });
    expect(m.text).toContain("5.0 MB");
  });

  it("says size was not reported rather than inventing a zero", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_succeeded", sizeBytes: null });
    expect(m.text).toContain("Size: not reported");
  });

  it("tells a failure reader what they can still restore", () => {
    const m = buildBackupEventEmail({
      ...base,
      event: "backup_failed",
      error: "ssh timeout",
      lastSuccessAt: new Date("2026-08-08T03:12:00Z")
    });
    expect(m.text).toContain("ssh timeout");
    expect(m.text).toContain("2026-08-08 03:12 UTC");
    expect(m.text).toContain("you can still restore from that one");
  });

  it("states plainly when a failure leaves no restore point at all", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_failed", lastSuccessAt: null });
    expect(m.text).toContain("no restore point");
  });

  it("ignores an unparseable last-success timestamp rather than printing garbage", () => {
    const m = buildBackupEventEmail({ ...base, event: "backup_failed", lastSuccessAt: "not a date" });
    expect(m.text).toContain("no restore point");
    expect(m.text).not.toContain("Invalid Date");
  });

  it("names the frequency when the schedule is turned on", () => {
    const m = buildBackupEventEmail({ ...base, event: "schedule_enabled", frequencyLabel: "Daily" });
    expect(m.subject).toContain("turned on");
    expect(m.text).toContain("Frequency: Daily");
  });

  it("warns that no new restore points will be made when turned off", () => {
    const m = buildBackupEventEmail({ ...base, event: "schedule_disabled" });
    expect(m.subject).toContain("turned off");
    expect(m.text).toContain("No new restore points");
  });
});
