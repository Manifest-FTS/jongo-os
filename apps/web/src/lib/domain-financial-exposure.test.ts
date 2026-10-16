import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), user: vi.fn(), grant: vi.fn(), domain: vi.fn(), domains: vi.fn(), charges: vi.fn(), organizations: vi.fn(), organization: vi.fn(), balance: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("@/lib/namecheap", () => ({ getBalance: m.balance, namecheapMode: () => "live" }));
vi.mock("@/components/PageAutoRefresh", () => ({ default: () => null }));
vi.mock("@/components/RemedyButton", () => ({ default: () => null }));
vi.mock("@/components/domains/DnsRecordsPanel", () => ({ default: () => null }));
vi.mock("@/components/domains/RenewDomainPanel", () => ({ default: () => React.createElement("div", null, "Renew financially") }));

import { DOMAIN_TECHNICAL_SELECT, getDomainViewer, loadDomainForViewer } from "./domain-access";
import DomainsPage from "../app/(platform)/my-domains/page";
import DomainDetailPage from "../app/(platform)/my-domains/[domainId]/page";

const id = "00000000-0000-4000-8000-000000000002";
const technical = { id, organizationId: "org", name: "example.com", status: "active", registrar: "namecheap", cloudflareZoneId: "zone", nameservers: ["ns.example.com"], dnsStatus: "active", expiresAt: null };

describe("domain server serialization boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("React", React);
    m.auth.mockResolvedValue({ user: { id: "u", email: "stale@example.com" } });
    m.getDb.mockResolvedValue({
      user: { findUnique: m.user }, platformAdmin: { findUnique: m.grant },
      domain: { findFirst: m.domain, findMany: m.domains }, domainCharge: { findMany: m.charges },
      organization: { findMany: m.organizations, findUnique: m.organization }
    });
    m.user.mockResolvedValue({ id: "u", email: "current@example.com", role: "admin", deletedAt: null });
    m.grant.mockResolvedValue(null);
    m.domain.mockResolvedValue(technical);
    m.domains.mockResolvedValue([{ ...technical, organization: { name: "Client" } }]);
    m.organizations.mockResolvedValue([{ id: "org", name: "Client" }]);
    m.organization.mockResolvedValue({ name: "Client" });
    m.charges.mockResolvedValue([]);
    m.balance.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["admin", "collaborator"])("never queries charges/balance or renders finance for %s", async (role) => {
    m.user.mockResolvedValue({ id: "u", email: "current@example.com", role, deletedAt: null });
    const list = renderToStaticMarkup(await DomainsPage());
    const detail = renderToStaticMarkup(await DomainDetailPage({ params: Promise.resolve({ domainId: id }), searchParams: Promise.resolve({ checkout: "success" }) }));
    expect(list + detail).toContain("example.com");
    expect(list + detail).not.toMatch(/Billing history|billing audit|Namecheap cost|Margin|Clients paid|Renew financially|Payment received|Register or transfer/);
    expect(m.charges).not.toHaveBeenCalled();
    expect(m.balance).not.toHaveBeenCalled();
    expect(m.domains.mock.calls[0][0].select).toEqual({ ...DOMAIN_TECHNICAL_SELECT, organization: { select: { name: true } } });
    expect(m.domain.mock.calls[0][0].select).toEqual(DOMAIN_TECHNICAL_SELECT);
    expect(JSON.stringify(m.domain.mock.calls)).not.toMatch(/isBillable|billingOverride|lastError|charges/);
  });

  it("preserves client-admin DNS control but scopes collaborators to their organizations", async () => {
    m.user.mockResolvedValue({ id: "u", email: "current@example.com", role: "collaborator", deletedAt: null });
    const viewer = await getDomainViewer();
    expect(viewer).toMatchObject({ email: "current@example.com", isPlatformAdmin: false, isSuperAdmin: false });
    expect((await loadDomainForViewer(id, viewer!))?.canManage).toBe(true);
    m.organizations.mockResolvedValueOnce([{ id: "other" }]);
    expect(await loadDomainForViewer(id, viewer!)).toBeNull();
    m.organizations.mockResolvedValueOnce([{ id: "org" }]).mockResolvedValueOnce([]);
    expect((await loadDomainForViewer(id, viewer!))?.canManage).toBe(false);
  });

  it("reads billing only for a fresh super admin and excludes charge secrets", async () => {
    m.user.mockResolvedValue({ id: "u", email: "super@example.com", role: "super_admin", deletedAt: null });
    const html = renderToStaticMarkup(await DomainsPage());
    expect(html).toContain("Domain billing audit");
    expect(m.charges).toHaveBeenCalledOnce();
    expect(m.balance).toHaveBeenCalledOnce();
    const select = m.charges.mock.calls[0][0].select;
    expect(select.clientCents).toBe(true);
    expect(select.registrantContact).toBeUndefined();
    expect(select.eppCode).toBeUndefined();
  });
});