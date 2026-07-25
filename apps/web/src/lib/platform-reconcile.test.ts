import { describe, expect, it } from "vitest";
import { findRepairTarget, type LiveResourceIndex, type SiteForReconcile } from "./platform-reconcile-match";

function index(resources: Array<{ uuid: string; kind: "service" | "application" | "database"; name: string; projectId: string }>): LiveResourceIndex {
  return { byUuid: new Set(resources.map((r) => r.uuid)), all: resources };
}

function site(overrides: Partial<SiteForReconcile> = {}): SiteForReconcile {
  return {
    id: "site-1",
    name: "Fucarino.com",
    coolifyServiceUuid: "deaduuid",
    coolifyProjectId: "proj-1",
    stagingEnabled: false,
    ...overrides
  };
}

describe("findRepairTarget", () => {
  it("repairs a stale mapping when exactly one live resource matches by name", () => {
    const target = findRepairTarget(
      index([{ uuid: "live-1", kind: "service", name: "Fucarino.com", projectId: "proj-1" }]),
      site()
    );
    expect(target?.uuid).toBe("live-1");
  });

  it("is case- and whitespace-insensitive on the name", () => {
    const target = findRepairTarget(
      index([{ uuid: "live-1", kind: "service", name: "  fucarino.com  ", projectId: "proj-1" }]),
      site()
    );
    expect(target?.uuid).toBe("live-1");
  });

  it("refuses to guess when multiple resources share a name across projects", () => {
    const target = findRepairTarget(
      index([
        { uuid: "live-1", kind: "service", name: "Fucarino.com", projectId: "other" },
        { uuid: "live-2", kind: "service", name: "Fucarino.com", projectId: "another" }
      ]),
      site()
    );
    expect(target).toBeNull();
  });

  it("disambiguates duplicates using the site's project", () => {
    const target = findRepairTarget(
      index([
        { uuid: "live-1", kind: "service", name: "Fucarino.com", projectId: "proj-1" },
        { uuid: "live-2", kind: "service", name: "Fucarino.com", projectId: "other" }
      ]),
      site()
    );
    expect(target?.uuid).toBe("live-1");
  });

  it("returns null when no live resource matches (deleted resource)", () => {
    const target = findRepairTarget(
      index([{ uuid: "live-1", kind: "service", name: "Something Else", projectId: "proj-1" }]),
      site()
    );
    expect(target).toBeNull();
  });
});

import { decideSiteArchive, shouldAbortArchiveBatch } from "./platform-reconcile-match";

describe("decideSiteArchive", () => {
  const now = new Date("2026-08-01T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it("never archives on an incomplete index, however old the miss", () => {
    const d = decideSiteArchive({ missingSince: daysAgo(90), now, indexComplete: false });
    expect(d.archive).toBe(false);
    expect(d.reason).toBe("index_incomplete");
  });

  it("does not archive a resource that is present", () => {
    expect(decideSiteArchive({ missingSince: null, now }).archive).toBe(false);
  });

  it("waits out the grace period", () => {
    expect(decideSiteArchive({ missingSince: daysAgo(3), now, graceDays: 7 }).archive).toBe(false);
  });

  it("archives once missing beyond the grace period", () => {
    const d = decideSiteArchive({ missingSince: daysAgo(8), now, graceDays: 7 });
    expect(d.archive).toBe(true);
    expect(d.reason).toBe("missing_beyond_grace");
  });
});

describe("shouldAbortArchiveBatch", () => {
  it("aborts when a suspiciously large share looks deleted", () => {
    const r = shouldAbortArchiveBatch({ candidates: 30, totalSites: 45 });
    expect(r.abort).toBe(true);
  });

  it("allows a small number of genuine deletions", () => {
    expect(shouldAbortArchiveBatch({ candidates: 2, totalSites: 45 }).abort).toBe(false);
  });

  it("does not judge tiny installs", () => {
    expect(shouldAbortArchiveBatch({ candidates: 2, totalSites: 2 }).abort).toBe(false);
  });
});

import { isBackupDue, selectDueBackups,
  orderDueBackups, type ScheduleCandidate } from "./platform-reconcile-match";

describe("scheduled backups", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 60 * 60 * 1000);
  const cand = (o: Partial<ScheduleCandidate>): ScheduleCandidate => ({
    id: "s", slug: "s", backupScheduleEnabled: null,
    backupFrequencyHours: 24, lastScheduledBackupAt: hoursAgo(1), ...o
  });

  it("is off unless enabled per-site or by platform default", () => {
    expect(isBackupDue(cand({ lastScheduledBackupAt: null }), { now })).toBe(false);
    expect(isBackupDue(cand({ lastScheduledBackupAt: null }), { now, platformDefaultEnabled: true })).toBe(true);
  });

  it("lets a site opt out of the platform default", () => {
    expect(isBackupDue(cand({ backupScheduleEnabled: false, lastScheduledBackupAt: null }),
      { now, platformDefaultEnabled: true })).toBe(false);
  });

  it("respects the frequency window", () => {
    expect(isBackupDue(cand({ backupScheduleEnabled: true, lastScheduledBackupAt: hoursAgo(5) }), { now })).toBe(false);
    expect(isBackupDue(cand({ backupScheduleEnabled: true, lastScheduledBackupAt: hoursAgo(25) }), { now })).toBe(true);
  });

  it("caps how many run per pass, most-overdue first", () => {
    const sites = [
      cand({ id: "recent", backupScheduleEnabled: true, lastScheduledBackupAt: hoursAgo(25) }),
      cand({ id: "never", backupScheduleEnabled: true, lastScheduledBackupAt: null }),
      cand({ id: "oldest", backupScheduleEnabled: true, lastScheduledBackupAt: hoursAgo(200) })
    ];
    const picked = selectDueBackups(sites, { now, maxPerRun: 2 });
    expect(picked).toHaveLength(2);
    expect(picked[0].id).toBe("never");   // never-run first
    expect(picked[1].id).toBe("oldest");
  });

  it("returns nothing when none are due", () => {
    expect(selectDueBackups([cand({ backupScheduleEnabled: true })], { now })).toHaveLength(0);
  });
});

describe("orderDueBackups", () => {
  const base = { backupScheduleEnabled: true, backupFrequencyHours: 24 };
  const now = new Date("2026-07-25T12:00:00Z");

  it("returns every due site, not just the per-run budget", () => {
    const sites = [
      { id: "a", slug: "a", ...base, lastScheduledBackupAt: new Date("2026-07-20T00:00:00Z") },
      { id: "b", slug: "b", ...base, lastScheduledBackupAt: new Date("2026-07-22T00:00:00Z") },
      { id: "c", slug: "c", ...base, lastScheduledBackupAt: new Date("2026-07-21T00:00:00Z") }
    ];
    // Uncapped, so the caller can skip ineligible sites without losing its
    // budget to them.
    expect(orderDueBackups(sites, { now }).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(selectDueBackups(sites, { now, maxPerRun: 1 }).map((s) => s.id)).toEqual(["a"]);
  });

  it("still excludes sites that are not due", () => {
    const sites = [
      { id: "fresh", slug: "fresh", ...base, lastScheduledBackupAt: new Date("2026-07-25T11:00:00Z") },
      { id: "old", slug: "old", ...base, lastScheduledBackupAt: new Date("2026-07-01T00:00:00Z") }
    ];
    expect(orderDueBackups(sites, { now }).map((s) => s.id)).toEqual(["old"]);
  });
});
