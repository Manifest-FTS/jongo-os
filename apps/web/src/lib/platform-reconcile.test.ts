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
