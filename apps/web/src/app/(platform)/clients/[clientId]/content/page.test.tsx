import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), user: vi.fn(), org: vi.fn(), member: vi.fn(), grant: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
// Import the actual clients route and REAL capability/principal resolvers; no framework shell or DB calls.
import ClientContentPage from "./page";

const clientId = "11111111-1111-4111-8111-111111111111";
let actor: { id: string; email: string; role: string; deletedAt: Date | null } | null;
let owner: Record<string, unknown> | null;
let membership: Record<string, unknown> | null;
const render = async (id = clientId) => renderToStaticMarkup(await ClientContentPage({ params: Promise.resolve({ clientId: id }) }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
  vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "");
  actor = { id: "owner", email: "fresh@example.test", role: "collaborator", deletedAt: null };
  owner = { id: "owner", deletedAt: null, subscriptionPlanId: "enterprise-sla", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date("2099-01-01") };
  membership = null;
  m.auth.mockResolvedValue({ user: { id: "owner", email: "stale@example.test", role: "super_admin" } });
  m.getDb.mockResolvedValue({ user: { findUnique: m.user }, organization: { findUnique: m.org }, collaborator: { findFirst: m.member }, platformAdmin: { findUnique: m.grant } });
  m.user.mockImplementation(async ({ where, select }) => select.subscriptionPlanId ? owner : where.id === actor?.id ? actor : null);
  m.org.mockImplementation(async ({ where }) => where.id === clientId ? { id: clientId, ownerId: "owner", deletedAt: null } : null);
  m.member.mockImplementation(async ({ where }) => membership && Object.entries(where).every(([key, value]) => membership![key] === value) ? membership : null);
  m.grant.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("actual /clients/[clientId]/content page scope", () => {
  it("awaits authenticated organization authorization and sends only descriptors and an author boolean", async () => {
    const element = await ClientContentPage({ params: Promise.resolve({ clientId }) });
    const builder = React.Children.toArray(element.props.children).find((child) => React.isValidElement(child) && typeof child.type === "function") as React.ReactElement;
    expect(Object.keys(builder.props).sort()).toEqual(["canAuthor", "schemas"]);
    expect(builder.props.schemas).toHaveLength(6);
    expect(builder.props.canAuthor).toBe(true);
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Validate locally");
    expect(html).not.toMatch(/enterprise-sla|subscription|stripe|billing|fresh@example|stale@example|ownerId/);
    expect(m.user).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "owner" }, select: expect.objectContaining({ role: true }) }));
  });
  it.each(["slug", "", "../client", "11111111-1111-4111-8111-11111111111Z"])("rejects non-UUID client ID %s before lookup", async (id) => {
    await expect(render(id)).rejects.toThrow("not found");
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it("denies missing session identity without repository/mock lookup", async () => {
    m.auth.mockResolvedValue({ user: { email: "bootstrap@example.test" } });
    await expect(render()).rejects.toThrow("not found");
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it("returns only a feature-off notice without resolving organization or schemas", async () => {
    vi.stubEnv("JONGO_CMS_ENABLED", "false");
    const html = await render();
    expect(html).toContain("The CMS feature is disabled");
    expect(html).not.toContain("agencyWork");
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it.each(["super_admin", "admin", "bootstrap", "PlatformAdmin"])("does not automatically grant %s content scope", async (kind) => {
    actor!.id = "outsider";
    m.auth.mockResolvedValue({ user: { id: "outsider", role: "super_admin" } });
    if (kind === "bootstrap") vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", actor!.email);
    else if (kind === "PlatformAdmin") m.grant.mockResolvedValue({ id: "technical-grant" });
    else actor!.role = kind;
    await expect(render()).rejects.toThrow("not found");
    expect(m.member).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: clientId, userId: "outsider", deletedAt: null } }));
  });
  it.each(["admin", "collaborator"])("allows live organization %s descriptors but disables author controls", async (role) => {
    actor!.id = "member";
    m.auth.mockResolvedValue({ user: { id: "member" } });
    membership = { organizationId: clientId, userId: "member", role, deletedAt: null };
    expect(await render()).toContain('<fieldset disabled=""');
    membership = null; // site-only or revoked org grant is not content scope
    await expect(render()).rejects.toThrow("not found");
  });
  it("rereads downgrade and identity instead of trusting JWT or earlier render", async () => {
    expect(await render()).not.toContain('<fieldset disabled=""');
    owner!.subscriptionStatus = "past_due";
    expect(await render()).toContain('<fieldset disabled=""');
    actor = null;
    await expect(render()).rejects.toThrow("not found");
  });
  it.each(["cross-tenant", "DB outage", "missing owner", "deleted actor"])("fails closed for %s without DTO leakage", async (kind) => {
    if (kind === "DB outage") m.getDb.mockRejectedValue(new Error("private provider details"));
    if (kind === "missing owner") owner = null;
    if (kind === "deleted actor") actor!.deletedAt = new Date();
    await expect(render(kind === "cross-tenant" ? "22222222-2222-4222-8222-222222222222" : clientId)).rejects.toThrow("not found");
  });
});