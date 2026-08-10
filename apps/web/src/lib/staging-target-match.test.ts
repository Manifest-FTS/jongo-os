import { describe, expect, it } from "vitest";
import {
  isStagingSibling,
  normalizeStagingNameKey,
  pickStagingTarget,
  stripStageHints
} from "./staging-target-match";

describe("normalizeStagingNameKey / stripStageHints", () => {
  it("reduces a production app and its staging sibling to the same key", () => {
    expect(stripStageHints(normalizeStagingNameKey("Acme Dental"))).toBe("acme-dental");
    expect(stripStageHints(normalizeStagingNameKey("acme-dental-staging"))).toBe("acme-dental");
    expect(stripStageHints(normalizeStagingNameKey("Acme_Dental Production"))).toBe("acme-dental");
  });

  it("strips two stacked environment suffixes", () => {
    expect(stripStageHints(normalizeStagingNameKey("acme-staging-prod"))).toBe("acme");
  });
});

describe("isStagingSibling — strict (the enable path)", () => {
  it("matches the app's own staging counterpart", () => {
    expect(isStagingSibling("acme-dental", "acme-dental-staging")).toMatchObject({
      match: true,
      reason: "exact_key"
    });
  });

  it("refuses a different app whose name merely contains this one", () => {
    // The reported bug: enabling staging for one app adopted a neighbour's
    // staging site and displayed its values.
    expect(isStagingSibling("acme", "acme-other-client-staging").match).toBe(false);
    expect(isStagingSibling("acme-other-client", "acme-staging").match).toBe(false);
  });

  it("refuses when either name is unreadable instead of matching everything", () => {
    // This returned true before, which is a wildcard: "we could not tell" became
    // "yes, attach to it and sync production content into it".
    expect(isStagingSibling("acme", "").match).toBe(false);
    expect(isStagingSibling("", "acme-staging").match).toBe(false);
  });

  it("is not confused by punctuation or casing differences", () => {
    expect(isStagingSibling("Acme Dental", "ACME_DENTAL-Stage").match).toBe(true);
  });
});

describe("isStagingSibling — relaxed (display and preflight)", () => {
  it("still allows containment, where a generous guess is survivable", () => {
    expect(isStagingSibling("acme", "acme-other-client-staging", { relaxed: true })).toMatchObject({
      match: true,
      reason: "substring_relaxed"
    });
  });

  it("ignores containment below the length floor", () => {
    // A 3-character key would match almost anything.
    expect(isStagingSibling("gse", "gse-other-staging", { relaxed: true }).match).toBe(false);
  });
});

describe("pickStagingTarget", () => {
  const candidates = [
    { uuid: "u1", name: "acme-dental-staging" },
    { uuid: "u2", name: "other-client-staging" }
  ];

  it("picks the name-matched sibling, not the first in the list", () => {
    const picked = pickStagingTarget("acme-dental", candidates);
    expect(picked.selected?.uuid).toBe("u1");
    expect(picked.matchedCount).toBe(1);
    expect(picked.adoptedWithoutNameMatch).toBe(false);
  });

  it("selects nothing when no candidate is this app's staging", () => {
    // The enable path must then PROVISION rather than attach to a stranger.
    const picked = pickStagingTarget("brand-new-app", candidates);
    expect(picked.selected).toBeUndefined();
    expect(picked.candidateCount).toBe(2);
  });

  it("excludes the production resource itself", () => {
    const picked = pickStagingTarget("acme-dental", [{ uuid: "prod", name: "acme-dental" }], {
      excludeUuid: "prod"
    });
    expect(picked.selected).toBeUndefined();
    expect(picked.candidateCount).toBe(0);
  });

  it("does NOT adopt a lone unrelated candidate unless the caller opts in", () => {
    const lone = [{ uuid: "u9", name: "someone-elses-staging" }];
    expect(pickStagingTarget("acme-dental", lone).selected).toBeUndefined();
  });

  it("adopts a lone candidate when opted in, and says the name did not match", () => {
    // Reported separately so a caller can log it rather than believe it was a
    // real match.
    const lone = [{ uuid: "u9", name: "someone-elses-staging" }];
    const picked = pickStagingTarget("acme-dental", lone, { allowLoneCandidateFallback: true });
    expect(picked.selected?.uuid).toBe("u9");
    expect(picked.adoptedWithoutNameMatch).toBe(true);
    expect(picked.matchedCount).toBe(0);
  });

  it("prefers a real name match over the lone-candidate fallback", () => {
    const picked = pickStagingTarget("acme-dental", [{ uuid: "u1", name: "acme-dental-stage" }], {
      allowLoneCandidateFallback: true
    });
    expect(picked.adoptedWithoutNameMatch).toBe(false);
    expect(picked.selected?.uuid).toBe("u1");
  });
});
