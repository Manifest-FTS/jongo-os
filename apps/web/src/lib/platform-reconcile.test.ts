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
