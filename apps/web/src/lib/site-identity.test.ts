import { describe, expect, it } from "vitest";
import { buildSiteIdentityWhere, isUuid } from "./site-identity";

describe("site identity guards", () => {
  it("treats a slug-like identifier as a slug, not a UUID id", () => {
    expect(isUuid("gardenstateequality-org")).toBe(false);
    expect(buildSiteIdentityWhere("gardenstateequality-org")).toEqual({
      slug: "gardenstateequality-org",
      deletedAt: null
    });
  });

  it("keeps UUID lookups compatible with database UUID IDs", () => {
    const siteId = "123e4567-e89b-42d3-a456-426614174000";

    expect(buildSiteIdentityWhere(siteId)).toEqual({
      OR: [
        { id: siteId },
        { slug: siteId },
        { coolifyServiceUuid: siteId },
        { coolifyServiceId: siteId },
        { coolifyProjectId: siteId }
      ],
      deletedAt: null
    });
  });
});
