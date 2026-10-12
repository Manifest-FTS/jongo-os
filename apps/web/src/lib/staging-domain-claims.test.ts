import { describe, expect, it } from "vitest";
import { decideClaim, type ExistingClaim } from "./staging-domain-claims";

const SITE_A = "11111111-1111-1111-1111-111111111111";
const SITE_B = "22222222-2222-2222-2222-222222222222";

describe("decideClaim", () => {
  const options = { hostsInUseElsewhere: [] as string[], max: 2 };

  it("allows a hostname nobody has claimed", () => {
    expect(decideClaim("staging.clientsite.com", SITE_A, [], options)).toEqual({ ok: true });
  });

  it("refuses a hostname another site already claimed, in any live state", () => {
    for (const status of ["pending_dns", "verified", "active", "dns_lost", "failed"]) {
      const existing: ExistingClaim[] = [{ hostname: "staging.clientsite.com", siteId: SITE_B, status }];
      expect(decideClaim("staging.clientsite.com", SITE_A, existing, options)).toEqual({ ok: false, reason: "taken_by_other_site" });
    }
  });

  it("says 'already added' when the same site adds it twice", () => {
    const existing: ExistingClaim[] = [{ hostname: "staging.clientsite.com", siteId: SITE_A, status: "pending_dns" }];
    expect(decideClaim("staging.clientsite.com", SITE_A, existing, options)).toEqual({ ok: false, reason: "already_added" });
  });

  it("frees a hostname once its claim is removed", () => {
    const existing: ExistingClaim[] = [{ hostname: "staging.clientsite.com", siteId: SITE_B, status: "removed" }];
    expect(decideClaim("staging.clientsite.com", SITE_A, existing, options)).toEqual({ ok: true });
  });

  it("compares hostnames case-insensitively", () => {
    const existing: ExistingClaim[] = [{ hostname: "Staging.ClientSite.com", siteId: SITE_B, status: "active" }];
    expect(decideClaim("staging.clientsite.com", SITE_A, existing, options)).toEqual({ ok: false, reason: "taken_by_other_site" });
  });

  it("refuses a hostname another Coolify resource already serves (someone's production)", () => {
    expect(
      decideClaim("shop.clientsite.com", SITE_A, [], { hostsInUseElsewhere: ["shop.clientsite.com"], max: 2 })
    ).toEqual({ ok: false, reason: "in_use_elsewhere" });
  });

  it("enforces the per-site limit, counting only this site's live claims", () => {
    const existing: ExistingClaim[] = [
      { hostname: "a.clientsite.com", siteId: SITE_A, status: "active" },
      { hostname: "b.clientsite.com", siteId: SITE_A, status: "pending_dns" },
      { hostname: "c.clientsite.com", siteId: SITE_A, status: "removed" },
      { hostname: "d.other.com", siteId: SITE_B, status: "active" }
    ];
    expect(decideClaim("e.clientsite.com", SITE_A, existing, options)).toEqual({ ok: false, reason: "limit_reached" });
    expect(decideClaim("e.other.com", SITE_B, existing, options)).toEqual({ ok: true });
  });
});
