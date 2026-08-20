import { describe, expect, it } from "vitest";
import {
  chooseCanonicalDirectoryCandidate,
  resolveLiveWorkspaceIdentity
} from "./site-directory-canonical";

describe("chooseCanonicalDirectoryCandidate", () => {
  it("prefers the DB duplicate whose name and stable slug match the live resource", () => {
    const mistyped = { id: "mistyped", name: "teach-manul", slug: "teach-manul", source: "db" as const };
    const canonical = { id: "canonical", name: "teach.lgbt", slug: "teach-lgbt", source: "db" as const };

    expect(chooseCanonicalDirectoryCandidate(mistyped, canonical, "teach.lgbt", "teach-lgbt"))
      .toBe(canonical);
  });

  it("prefers the stable slug when multiple DB duplicates share the live name", () => {
    const importedDuplicate = { id: "duplicate", name: "teach.lgbt", slug: "teach-lgbt-2", source: "db" as const };
    const canonical = { id: "canonical", name: "teach.lgbt", slug: "teach-lgbt", source: "db" as const };

    expect(chooseCanonicalDirectoryCandidate(importedDuplicate, canonical, "teach.lgbt", "teach-lgbt"))
      .toBe(canonical);
  });

  it("uses the live name and canonical slug for a stale direct workspace alias", () => {
    expect(resolveLiveWorkspaceIdentity({
      storedName: "teach-manul",
      storedSlug: "teach-manul",
      storedTemporaryDomainSlug: "teach-manul",
      liveName: "teach.lgbt",
      liveCanonicalSlug: "teach-lgbt"
    })).toEqual({
      name: "teach.lgbt",
      slug: "teach-lgbt",
      temporaryDomainSlug: "teach-lgbt"
    });
  });

  it("keeps a custom domain slug when the stored name is already current", () => {
    expect(resolveLiveWorkspaceIdentity({
      storedName: "teach.lgbt",
      storedSlug: "teach-lgbt",
      storedTemporaryDomainSlug: "custom-teach",
      liveName: "teach.lgbt",
      liveCanonicalSlug: "teach-lgbt"
    }).temporaryDomainSlug).toBe("custom-teach");
  });
});
