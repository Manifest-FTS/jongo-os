import { describe, expect, it } from "vitest";
import { managedDomainDto, managedDomainQuery, managedDomainSelect, validateManagedDomainUpdate, type ManagedDomainRow } from "./managed-domains";

const id = "10000000-0000-0000-0000-000000000001";
const other = "10000000-0000-0000-0000-000000000002";
const row = {
  id, name: "example.test", organizationId: id, status: "active", registrar: "namecheap", expiresAt: null,
  autoRenew: true, dnsStatus: "active", nameservers: ["ns1.example.test"], cloudflareZoneId: null, registrarSyncedAt: null,
  organization: { id, name: "Client", billingMode: "manual_override", billingStatus: "past_due", billingNotes: "PRIVATE NOTE", bonsaiClientId: "client1", externalInvoiceUrl: "https://invoice.test" },
  isBillable: true, billingOverride: true, eppCode: "SECRET", registrantContact: "SECRET", lastError: "SECRET"
} as ManagedDomainRow;

describe("managed domain tenant scope and DTO", () => {
  it("uses explicit technical selections and strips finances/secrets even from over-selected rows", async () => {
    const select = JSON.stringify(managedDomainSelect(false));
    expect(select).not.toMatch(/billing|Billable|bonsai|Invoice|charges|epp|Contact|lastError/);
    const dto = await managedDomainDto(row, false);
    expect(dto.client).toEqual({ id, name: "Client" });
    expect(Object.keys(dto).sort()).toEqual(["id", "name", "organizationId", "client", "status", "registrar", "expiresAt", "autoRenew", "dnsStatus", "nameservers", "cloudflareZoneId", "registrarSyncedAt"].sort());
    expect(JSON.stringify(dto)).not.toMatch(/PRIVATE|SECRET|billing|Billable|bonsai|Invoice/);
  });

  it("only super gets an explicit client financial DTO and unmapped rows have no client finances", async () => {
    expect(await managedDomainDto(row, true)).toMatchObject({ financial: { isBillable: true, billingOverride: true, clientBilling: { billingStatus: "past_due", billingNotes: "PRIVATE NOTE" } } });
    expect(JSON.stringify(await managedDomainDto(row, true))).not.toContain("SECRET");
    expect(await managedDomainDto({ ...row, organization: null, organizationId: null }, true)).toMatchObject({ financial: { clientBilling: null } });
  });

  it("always scopes collaborators to non-null visible org IDs, including empty scope and arbitrary client filter", () => {
    expect(managedDomainQuery(new URLSearchParams(), false, [id]).where).toEqual({ deletedAt: null, organizationId: { in: [id] } });
    expect(managedDomainQuery(new URLSearchParams(), false, []).where).toEqual({ deletedAt: null, organizationId: { in: [] } });
    expect(managedDomainQuery(new URLSearchParams(`clientId=${other}`), false, [id]).where).toEqual({ deletedAt: null, organizationId: { in: [] } });
  });

  it("allows global technical inventory but denies the unmapped filter to non-super", () => {
    expect(managedDomainQuery(new URLSearchParams(), false, null).where).toEqual({ deletedAt: null });
    expect(() => managedDomainQuery(new URLSearchParams("assignment=unassigned"), false, null)).toThrow("Forbidden");
    expect(() => managedDomainQuery(new URLSearchParams("assignment=unassigned"), false, [id])).toThrow("Forbidden");
    expect(managedDomainQuery(new URLSearchParams("assignment=unassigned"), true, null).where).toEqual({ deletedAt: null, organizationId: null });
  });

  it.each(["assignment=bad", "clientId=invalid", `clientId=${id}&assignment=unassigned`, `q=${"x".repeat(254)}`])("rejects invalid filter %s", (query) => {
    expect(() => managedDomainQuery(new URLSearchParams(query), true, null)).toThrow();
  });

  it("rejects assignment and flag mass assignment/coercion", () => {
    for (const input of [null, [], {}, { domainId: id }, { domainId: id, autoRenew: true }, { domainId: id, organizationId: "bad" }, { domainId: id, isBillable: "false" }, { domainId: id, billingOverride: 1 }, { domainId: id, name: "hijack" }, { domainId: "bad", organizationId: id }]) {
      expect(() => validateManagedDomainUpdate(input)).toThrow();
    }
    expect(validateManagedDomainUpdate({ domainId: id, organizationId: null, isBillable: false, billingOverride: true }))
      .toEqual({ domainId: id, data: { organizationId: null, isBillable: false, billingOverride: true } });
  });
});