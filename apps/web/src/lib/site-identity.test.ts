import { describe, expect, it } from "vitest";
import { buildSiteIdentityWhere, isUuid } from "./site-identity";

describe("site identity guards", () => {
  it("matches a non-UUID identifier as a slug or a hosting resource id, never a database id", () => {
    expect(isUuid("gardenstateequality-org")).toBe(false);
    expect(buildSiteIdentityWhere("gardenstateequality-org")).toEqual({
      OR: [{ slug: "gardenstateequality-org" }, { coolifyServiceUuid: "gardenstateequality-org" }, { coolifyServiceId: "gardenstateequality-org" }],
      deletedAt: null
    });
  });

  it("finds an app by its hosting id (Coolify ids are not UUIDs)", () => {
    const where = buildSiteIdentityWhere("dt0v391xre5rgtp50062tunm") as { OR: unknown[] };
    expect(where.OR).toContainEqual({ coolifyServiceUuid: "dt0v391xre5rgtp50062tunm" });
    expect(where.OR).not.toContainEqual({ id: "dt0v391xre5rgtp50062tunm" });
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
