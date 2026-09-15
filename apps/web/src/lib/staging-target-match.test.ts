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

  it("keeps a leading staging- so relaxed containment cannot hand one app's copy to its siblings", () => {
    // Stripping it made "staging-acme" contain-match both acme.org and
    // acme.education, locking the sibling's switch.
    const key = stripStageHints(normalizeStagingNameKey("staging-acme"));
    expect(key).toBe("staging-acme");
    expect(isStagingSibling("acme.education", "staging-acme", { relaxed: true }).match).toBe(false);
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

describe("pickStagingTarget — the copy Jongo recorded", () => {
  // The reported case: copies named after the temporary-domain slug, which
  // looks nothing like the production name. With one copy the lone-candidate
  // rule found it by luck; a second copy made both invisible, so the switch
  // locked and the Staging page said "target missing".
  const twoUnnamedCopies = [
    { uuid: "old", name: "staging-acmeco" },
    { uuid: "new", name: "staging-ac" }
  ];

  it("finds the recorded copy even when no name matches and there are two", () => {
    for (const relaxed of [false, true]) {
      const picked = pickStagingTarget("acme.org", twoUnnamedCopies, {
        relaxed,
        allowLoneCandidateFallback: relaxed,
        pinnedUuid: "new"
      });
      expect(picked.selected?.uuid).toBe("new");
      expect(picked.pinned).toBe(true);
    }
  });

  it("wins over a name match to a different copy", () => {
    const picked = pickStagingTarget("acme", [
      { uuid: "named", name: "acme-staging" },
      { uuid: "recorded", name: "staging-x" }
    ], { pinnedUuid: "recorded" });
    expect(picked.selected?.uuid).toBe("recorded");
  });

  it("falls back to the name rules when the recorded copy is gone", () => {
    const picked = pickStagingTarget("acme", [{ uuid: "named", name: "acme-staging" }], { pinnedUuid: "deleted" });
    expect(picked.selected?.uuid).toBe("named");
    expect(picked.pinned).toBe(false);
  });

  it("does not adopt a sibling's recorded copy through the lone-candidate rule", () => {
    // Two apps share a project; once the other copies are gone, the sibling's
    // copy is the only resource left in the staging environment.
    const picked = pickStagingTarget("acme.education", [{ uuid: "sibling-copy", name: "staging-ac" }], {
      relaxed: true,
      allowLoneCandidateFallback: true,
      excludeUuids: ["sibling-copy"]
    });
    expect(picked.selected).toBeUndefined();
    expect(picked.candidateCount).toBe(0);
  });

  it("does not select a sibling's recorded copy even when the name matches", () => {
    const picked = pickStagingTarget("acme", [{ uuid: "sibling-copy", name: "acme-staging" }], {
      excludeUuids: ["sibling-copy"]
    });
    expect(picked.selected).toBeUndefined();
  });

  it("never selects the production resource, even if it was recorded by mistake", () => {
    const picked = pickStagingTarget("acme", [{ uuid: "prod", name: "acme" }], {
      excludeUuid: "prod",
      pinnedUuid: "prod"
    });
    expect(picked.selected).toBeUndefined();
  });
});
