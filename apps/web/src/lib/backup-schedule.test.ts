import { describe, expect, it } from "vitest";
import {
  isValidBackupFrequency,
  describeBackupFrequency,
  summarizeBackupSchedule
} from "./backup-schedule";

const now = new Date("2026-07-25T12:00:00Z");

describe("isValidBackupFrequency", () => {
  it("accepts only the offered choices", () => {
    expect(isValidBackupFrequency(24)).toBe(true);
    expect(isValidBackupFrequency(168)).toBe(true);
    expect(isValidBackupFrequency(1)).toBe(false);
    expect(isValidBackupFrequency("24")).toBe(false);
    expect(isValidBackupFrequency(null)).toBe(false);
  });
});

describe("describeBackupFrequency", () => {
  it("names the known choices and falls back sensibly", () => {
    expect(describeBackupFrequency(24)).toBe("Daily");
    expect(describeBackupFrequency(168)).toBe("Weekly");
    expect(describeBackupFrequency(null)).toBe("Daily");
    expect(describeBackupFrequency(0)).toBe("Daily");
    expect(describeBackupFrequency(36)).toBe("Every 36 hours");
  });
});

describe("summarizeBackupSchedule", () => {
  it("inherits the platform default when the site has made no choice", () => {
    const on = summarizeBackupSchedule({
      backupScheduleEnabled: null,
      backupFrequencyHours: 24,
      lastScheduledBackupAt: null,
      platformDefaultEnabled: true,
      now
    });
    expect(on.enabled).toBe(true);
    expect(on.inheritsDefault).toBe(true);

    const off = summarizeBackupSchedule({
      backupScheduleEnabled: null,
      backupFrequencyHours: 24,
      lastScheduledBackupAt: null,
      platformDefaultEnabled: false,
      now
    });
    expect(off.enabled).toBe(false);
  });

  it("lets an explicit site choice override the platform default in both directions", () => {
    expect(
      summarizeBackupSchedule({
        backupScheduleEnabled: false,
        backupFrequencyHours: 24,
        lastScheduledBackupAt: null,
        platformDefaultEnabled: true,
        now
      }).enabled
    ).toBe(false);

    expect(
      summarizeBackupSchedule({
        backupScheduleEnabled: true,
        backupFrequencyHours: 24,
        lastScheduledBackupAt: null,
        platformDefaultEnabled: false,
        now
      }).enabled
    ).toBe(true);
  });

  it("computes the next run from the last run plus the frequency", () => {
    const s = summarizeBackupSchedule({
      backupScheduleEnabled: true,
      backupFrequencyHours: 24,
      lastScheduledBackupAt: new Date("2026-07-25T06:00:00Z"),
      now
    });
    expect(s.nextRunAt).toBe("2026-07-26T06:00:00.000Z");
    expect(s.detail).toMatch(/next backup 2026-07-26 06:00 UTC/);
  });

  it("says a due backup starts within the hour rather than naming a past time", () => {
    const s = summarizeBackupSchedule({
      backupScheduleEnabled: true,
      backupFrequencyHours: 24,
      lastScheduledBackupAt: new Date("2026-07-23T06:00:00Z"),
      now
    });
    expect(s.detail).toMatch(/due now/);
  });

  it("reports no next run and keeps on-demand available when the schedule is off", () => {
    const s = summarizeBackupSchedule({
      backupScheduleEnabled: false,
      backupFrequencyHours: 24,
      lastScheduledBackupAt: new Date("2026-07-24T06:00:00Z"),
      now
    });
    expect(s.nextRunAt).toBeNull();
    expect(s.lastRunAt).toBe("2026-07-24T06:00:00.000Z");
    expect(s.detail).toMatch(/still take a backup/i);
  });

  it("ignores an unparseable last-run timestamp instead of emitting Invalid Date", () => {
    const s = summarizeBackupSchedule({
      backupScheduleEnabled: true,
      backupFrequencyHours: 24,
      lastScheduledBackupAt: "not-a-date",
      now
    });
    expect(s.lastRunAt).toBeNull();
    expect(s.nextRunAt).toBeNull();
    expect(s.detail).toMatch(/first automatic backup/);
  });
});
