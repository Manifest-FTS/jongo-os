import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("@/lib/usage-store", () => ({
  getVisibleSiteIds: vi.fn(async () => []),
  getUsageReport: vi.fn(async () => ({
    rows: [{ key: "app", label: "App", siteId: "site", kind: "app", cpuCoreSeconds: 3600, memAvgBytes: 1024, memPeakBytes: 2048, memByteHours: 1024, egressBytes: 0, diskBytes: 0, hours: 1 }],
    hosts: [], measuredSeconds: 3600, hoursCovered: 1, available: true, daily: [], firstDataAt: null
  }))
}));
vi.mock("@/components/usage/UsageFilters", () => ({ default: () => null }));
vi.mock("@/components/usage/UsageMeter", () => ({ default: () => null }));
vi.mock("@/components/usage/UsageColumnChart", () => ({ default: () => null }));
vi.mock("@/components/usage/UsageLivePanel", () => ({ default: () => null }));
import UsagePage from "../app/(platform)/usage/page";

describe("usage cost server output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    vi.stubEnv("USAGE_HOST_MONTHLY_COST_USD", "730");
    m.auth.mockResolvedValue({ user: { id: "u", email: "user@example.com" } });
    m.getDb.mockResolvedValue({ user: { findUnique: m.user, findFirst: m.user }, site: { findMany: vi.fn(async () => []) }, platformAdmin: { findUnique: vi.fn(async () => ({ id: "technical-grant" })) } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it.each(["admin", "collaborator"])("withholds cost for %s even with a technical platform grant", async (role) => {
    m.user.mockResolvedValue({ id: "u", email: "user@example.com", role, deletedAt: null });
    const html = renderToStaticMarkup(await UsagePage({}));
    expect(html).not.toMatch(/Est\. cost|\$1\.00|Cost splits/);
  });
  it("shows cost only to DB super admins", async () => {
    m.user.mockResolvedValue({ id: "u", email: "user@example.com", role: "super_admin", deletedAt: null });
    const html = renderToStaticMarkup(await UsagePage({}));
    expect(html).toContain("Est. cost");
    expect(html).toContain("$1.00");
  });
});