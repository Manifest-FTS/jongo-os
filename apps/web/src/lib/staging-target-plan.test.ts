import { describe, expect, it } from "vitest";
import { planStagingPins, type PlanCopy, type PlanHistoryEvent, type PlanSite } from "./staging-target-plan";

const site = (over: Partial<PlanSite> & Pick<PlanSite, "id" | "name" | "coolifyServiceUuid">): PlanSite => ({
  coolifyProjectId: "p1",
  stagingTargetUuid: null,
  isStagingResource: false,
  ...over
});
const copy = (uuid: string, name: string, projectUuid = "p1"): PlanCopy => ({ uuid, name, projectUuid });
const event = (siteId: string, at: string, actionType: string, extra: Partial<PlanHistoryEvent> = {}): PlanHistoryEvent => ({
  siteId,
  at,
  actionType,
  ...extra
});

describe("planStagingPins — history", () => {
  // The reported shape: three apps in one project, two copies named after a
  // short slug that matches none of them. Only history can tell them apart.
  const sites = [
    site({ id: "s-org", name: "acme.org", coolifyServiceUuid: "prod-org" }),
    site({ id: "s-edu", name: "acme.education", coolifyServiceUuid: "prod-edu" }),
    site({ id: "s-other", name: "other.lgbt", coolifyServiceUuid: "prod-other" })
  ];
  const copies = [copy("old-copy", "staging-acmeco"), copy("new-copy", "staging-ac")];

  it("records the newest copy Jongo made for the app and leaves the older one unclaimed", () => {
    const plan = planStagingPins({
      sites,
      copies,
      history: [
        event("s-org", "2026-08-20T01:49:00Z", "staging_enable_provision", { uuid: "old-copy" }),
        event("s-org", "2026-08-31T20:04:00Z", "staging_disable_requested", { destroyedTargetCount: "0" }),
        event("s-org", "2026-09-12T13:16:00Z", "staging_enable_provision", { uuid: "new-copy" })
      ]
    });
    expect(plan.set).toEqual([{ productionUuid: "prod-org", siteIds: ["s-org"], copyUuid: "new-copy", reason: "history" }]);
    expect(plan.unclaimed.map((c) => c.uuid)).toEqual(["old-copy"]);
  });

  it("ignores records from before a disable that removed the copy", () => {
    const plan = planStagingPins({
      sites,
      copies,
      history: [
        event("s-edu", "2026-08-01T00:00:00Z", "staging_enable_provision", { uuid: "old-copy" }),
        event("s-edu", "2026-08-17T00:00:00Z", "staging_disable_requested", { destroyedTargetCount: "1" })
      ]
    });
    expect(plan.set).toEqual([]);
  });

  it("does not fall back to an older record when the newest copy is gone", () => {
    const plan = planStagingPins({
      sites,
      copies,
      history: [
        event("s-org", "2026-08-20T00:00:00Z", "staging_enable_provision", { uuid: "old-copy" }),
        event("s-org", "2026-09-12T00:00:00Z", "staging_enable_provision", { uuid: "deleted-copy" })
      ]
    });
    expect(plan.set).toEqual([]);
  });
});

describe("planStagingPins — without history", () => {
  it("records an exact name match", () => {
    const plan = planStagingPins({
      sites: [
        site({ id: "a", name: "acme", coolifyServiceUuid: "prod-a" }),
        site({ id: "b", name: "zeta", coolifyServiceUuid: "prod-b" })
      ],
      copies: [copy("c1", "acme-staging")],
      history: []
    });
    expect(plan.set).toMatchObject([{ copyUuid: "c1", reason: "name_match", siteIds: ["a"] }]);
  });

  it("records the only copy of a one-app project", () => {
    const plan = planStagingPins({
      sites: [site({ id: "a", name: "Acme Dental", coolifyServiceUuid: "prod-a" })],
      copies: [copy("c1", "staging.acmedental-org")],
      history: []
    });
    expect(plan.set).toMatchObject([{ copyUuid: "c1", reason: "only_app_in_project" }]);
  });

  it("never gives a lone copy to one of several apps without evidence", () => {
    const plan = planStagingPins({
      sites: [
        site({ id: "a", name: "acme.org", coolifyServiceUuid: "prod-a" }),
        site({ id: "b", name: "acme.education", coolifyServiceUuid: "prod-b" })
      ],
      copies: [copy("c1", "staging-ac")],
      history: []
    });
    expect(plan.set).toEqual([]);
    expect(plan.unclaimed.map((c) => c.uuid)).toEqual(["c1"]);
  });

  it("records nothing when two apps both claim the same copy", () => {
    const plan = planStagingPins({
      sites: [
        site({ id: "a", name: "acme", coolifyServiceUuid: "prod-a" }),
        site({ id: "b", name: "acme", coolifyServiceUuid: "prod-b" })
      ],
      copies: [copy("c1", "acme-staging")],
      history: []
    });
    expect(plan.set).toEqual([]);
    expect(plan.contested).toEqual([{ copyUuid: "c1", productionUuids: ["prod-a", "prod-b"] }]);
  });
});

describe("planStagingPins — what is not an app, and existing records", () => {
  it("does not treat a staging copy imported as its own site as an app", () => {
    const plan = planStagingPins({
      sites: [
        site({ id: "a", name: "acme.org", coolifyServiceUuid: "prod-a" }),
        site({ id: "copy-row", name: "staging.acme.org", coolifyServiceUuid: "c1" }),
        site({ id: "flagged", name: "x", coolifyServiceUuid: "prod-x", isStagingResource: true })
      ],
      copies: [copy("c1", "staging.acme.org")],
      history: []
    });
    // Only one real app is left in the project, so its lone copy is its own.
    expect(plan.set).toMatchObject([{ copyUuid: "c1", siteIds: ["a"] }]);
  });

  it("keeps an existing record and never offers that copy to another app", () => {
    const plan = planStagingPins({
      sites: [
        site({ id: "a", name: "acme", coolifyServiceUuid: "prod-a", stagingTargetUuid: "c1" }),
        site({ id: "b", name: "acme-two", coolifyServiceUuid: "prod-b" })
      ],
      copies: [copy("c1", "acme-two-staging")],
      history: []
    });
    expect(plan.set).toEqual([]);
    expect(plan.unclaimed).toEqual([]);
  });

  it("clears a record whose copy was deleted, but only on a complete inventory", () => {
    const sites = [site({ id: "a", name: "acme", coolifyServiceUuid: "prod-a", stagingTargetUuid: "gone" })];
    expect(planStagingPins({ sites, copies: [], history: [] }).clear).toMatchObject([{ copyUuid: "gone" }]);
    expect(planStagingPins({ sites, copies: [], history: [], indexComplete: false }).clear).toEqual([]);
  });

  it("records one copy for duplicate rows of the same production app", () => {
    const plan = planStagingPins({
      sites: [
        site({ id: "row1", name: "acme", coolifyServiceUuid: "prod-a" }),
        site({ id: "row2", name: "acme", coolifyServiceUuid: "prod-a" })
      ],
      copies: [copy("c1", "acme-staging")],
      history: []
    });
    expect(plan.set).toMatchObject([{ copyUuid: "c1", siteIds: ["row1", "row2"] }]);
  });
});
