import React from "react";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(), getDb: vi.fn(), user: vi.fn(), platformGrant: vi.fn(), org: vi.fn(),
  workspace: vi.fn(), admin: vi.fn(), sites: vi.fn(), overview: vi.fn(),
  github: vi.fn(), sources: vi.fn(), orgCaps: vi.fn(), datasetCaps: vi.fn(), documents: vi.fn()
}));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("@/lib/repositories", () => ({
  getClientWorkspace: m.workspace, isClientAdmin: m.admin,
  listSiteDirectory: m.sites, getSiteWorkspace: m.sites
}));
vi.mock("@/lib/coolify", () => ({ getCoolifyOverview: m.overview }));
vi.mock("@/lib/github-route-access", () => ({ canUseGithubForOrg: m.github }));
vi.mock("@/lib/github-installations", () => ({ listGitSources: m.sources }));
vi.mock("@/lib/cms/entitlements", () => ({ resolveOrganizationCmsCapabilities: m.orgCaps }));
vi.mock("@/lib/cms/dataset-access", () => ({ resolveDatasetCmsCapabilities: m.datasetCaps }));
vi.mock("@/lib/cms/documents", () => ({ getCmsDocument: m.documents, listCmsDocuments: m.documents }));
vi.mock("../app/(platform)/clients/[clientId]/content/[datasetId]/actions", () => ({
  createDraftSaveAction: vi.fn(),
  createMarketingAdminActions: () => ({ publish: vi.fn(), unpublish: vi.fn(), mint: vi.fn(), revoke: vi.fn() })
}));
vi.mock("@/components/cms/MarketingAdminControls", () => ({ default: () => null }));
vi.mock("@/components/navigation/WorkspaceTabs", () => ({
  default: ({ tabs }: any) => <nav>{tabs.map((tab: any) => <a key={tab.href} href={tab.href}>{tab.name}</a>)}</nav>
}));
// Do not load or change the editor/form implementations owned by other work.
vi.mock("@/components/cms/DraftEditor", () => ({ default: () => null }));
vi.mock("@/components/cms/CmsFormBuilder", () => ({ default: () => null }));
vi.mock("@/components/ClientInfoForm", () => ({ default: () => null }));
vi.mock("@/components/ClientOverviewCollaboratorsCard", () => ({ default: () => null }));
vi.mock("@/components/CreateSiteForm", () => ({ default: () => null }));
vi.mock("@/components/SiteDirectoryView", () => ({ default: () => null }));
vi.mock("@/components/GitSourcesManager", () => ({ default: () => null }));
vi.mock("@/components/CoolifyProjectMappingForm", () => ({ default: () => null }));
vi.mock("@/components/DeleteClientButton", () => ({ default: () => null }));

import { resolveClientLayoutAccess } from "./client-layout-access";
import Layout from "../app/(platform)/clients/[clientId]/layout";
import Overview from "../app/(platform)/clients/[clientId]/page";
import Apps from "../app/(platform)/clients/[clientId]/apps/page";
import Sources from "../app/(platform)/clients/[clientId]/sources/page";
import Settings from "../app/(platform)/clients/[clientId]/settings/page";
import Team from "../app/(platform)/clients/[clientId]/team/page";
import ContentPreview from "../app/(platform)/clients/[clientId]/content/page";
import Dataset from "../app/(platform)/clients/[clientId]/content/[datasetId]/page";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clientId = id(1), userId = id(2), datasetId = id(3);
const params = Promise.resolve({ clientId });
let client: any;
const isNotFound = (error: unknown): boolean => error instanceof Error &&
  (error.message === "not found" || Boolean((error as Error & { digest?: string }).digest?.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")));
const isRedirect = (error: unknown, location: string): boolean => error instanceof Error &&
  (error.message === `redirect:${location}` || ((error as Error & { digest?: string }).digest?.includes(location) ?? false));

// Evaluate the actual nested Prisma filters: an unconditional allowed fixture
// would miss deleted memberships, cross-client access and OR/AND mistakes.
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "OR") return value.some((condition: any) => matches(row, condition));
    if (key === "AND") return value.every((condition: any) => matches(row, condition));
    if (value && typeof value === "object" && "some" in value) {
      return row[key].some((related: any) => matches(related, value.some));
    }
    return row[key] === value;
  });
}
const draw = async (children: React.ReactNode = <p>Authorized child</p>) =>
  renderToStaticMarkup(await Layout({ params, children }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "");
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
  m.auth.mockResolvedValue({ user: { id: userId, email: "stale@example.test", role: "super_admin" } });
  m.getDb.mockResolvedValue({
    user: { findUnique: m.user }, platformAdmin: { findUnique: m.platformGrant },
    organization: { findFirst: m.org }
  });
  m.user.mockResolvedValue({ id: userId, email: "fresh@example.test", role: "collaborator", deletedAt: null });
  m.platformGrant.mockResolvedValue(null);
  client = {
    id: clientId, slug: "client-slug", name: "Minimal client label", deletedAt: null,
    ownerId: id(9), collaborators: [],
    sites: [{ id: id(4), deletedAt: null, collaborators: [{ userId, deletedAt: null }] }],
    description: "PRIVATE_SUMMARY", billingNotes: "PRIVATE_FINANCE"
  };
  m.org.mockImplementation(async ({ where, select }) => client && matches(client, where)
    ? Object.fromEntries(Object.keys(select).map((key) => [key, client[key]])) : null);
  m.workspace.mockResolvedValue(undefined);
  m.orgCaps.mockResolvedValue({ scope: "organization", organizationId: null, features: { "cms.read": false } });
  m.datasetCaps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canEdit: false });
  m.documents.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("client parent shell scope", () => {
  it("admits a live site member using only a minimal client projection", async () => {
    expect(await resolveClientLayoutAccess(clientId, userId)).toEqual({
      scope: "site", client: { id: clientId, name: "Minimal client label" }
    });
    expect(m.org).toHaveBeenCalledTimes(2);
    for (const [query] of m.org.mock.calls) expect(query.select).toEqual({ id: true, name: true });
    expect(m.org.mock.calls[1][0].where.sites).toEqual({ some: {
      deletedAt: null, collaborators: { some: { userId, deletedAt: null } }
    } });
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it("renders a readable site-only dataset through the actual parent, without client navigation/metadata", async () => {
    const child = await Dataset({ params: Promise.resolve({ clientId, datasetId }), searchParams: Promise.resolve({}) });
    const html = await draw(child);
    expect(html).toContain("Dataset content");
    expect(html).toContain("Minimal client label");
    for (const privateValue of ["PRIVATE_", "Overview", "Apps", "Sources", "Settings", "team member", "/clients/"]) {
      expect(html).not.toContain(privateValue);
    }
    expect(m.workspace).not.toHaveBeenCalled();
    expect(m.admin).not.toHaveBeenCalled();
    expect(m.documents).toHaveBeenCalledTimes(1);
    expect(m.documents).toHaveBeenCalledWith({ userId, datasetId, limit: 100, variant: "draft" });
  });

  it.each(["owner", "collaborator", "admin", "platform"])("preserves the full shell for existing %s authority", async (kind) => {
    if (kind === "owner") client.ownerId = userId;
    else if (kind === "platform") m.user.mockResolvedValue({ id: userId, email: "fresh@example.test", role: "admin", deletedAt: null });
    else client.collaborators = [{ userId, role: kind, deletedAt: null }];
    m.workspace.mockResolvedValue({ id: clientId, dbId: clientId, name: "Full client", summary: "Organization summary", siteCount: 8, memberCount: 6 });
    m.admin.mockResolvedValue(kind !== "collaborator");
    const html = await draw();
    expect(html).toContain("Overview"); expect(html).toContain("Apps"); expect(html).toContain("Sources");
    expect(html.includes("Settings")).toBe(kind !== "collaborator");
    expect(html).toContain("Organization summary");
    expect(m.org).toHaveBeenCalledTimes(1);
    expect(m.workspace).toHaveBeenCalledTimes(1);
  });

  it.each(["deleted member", "different member", "deleted site", "deleted client", "different client", "no site"])("denies %s", async (kind) => {
    if (kind === "deleted member") client.sites[0].collaborators[0].deletedAt = new Date();
    if (kind === "different member") client.sites[0].collaborators[0].userId = id(99);
    if (kind === "deleted site") client.sites[0].deletedAt = new Date();
    if (kind === "deleted client") client.deletedAt = new Date();
    if (kind === "different client") client.id = id(99);
    if (kind === "no site") client.sites = [];
    await expect(draw()).rejects.toSatisfy(isNotFound);
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it("rechecks revocation on the next request; deleted org membership is not an organization grant", async () => {
    client.collaborators = [{ userId, deletedAt: new Date() }];
    expect(await draw()).toContain("Site-scoped content access");
    client.sites[0].collaborators = [];
    await expect(draw()).rejects.toSatisfy(isNotFound);
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it.each([null, { id: userId, deletedAt: new Date(), role: "super_admin" }])("denies missing/deleted persisted identity %j", async (user) => {
    m.user.mockResolvedValue(user);
    await expect(draw()).rejects.toSatisfy(isNotFound);
    expect(m.org).not.toHaveBeenCalled(); expect(m.workspace).not.toHaveBeenCalled();
  });

  it("denies anonymous requests, outages, and missing detailed workspaces without falling back", async () => {
    m.auth.mockResolvedValueOnce(null);
    await expect(draw()).rejects.toSatisfy(isNotFound); expect(m.getDb).not.toHaveBeenCalled();
    m.org.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_FAILURE"));
    await expect(draw()).rejects.toSatisfy(isNotFound);
    client.ownerId = userId;
    await expect(draw()).rejects.toSatisfy(isNotFound);
    expect(m.workspace).toHaveBeenCalledTimes(1);
  });

  it("supports client slugs without treating non-UUID identifiers as database IDs", async () => {
    expect((await resolveClientLayoutAccess("client-slug", userId))?.scope).toBe("site");
    expect(m.org.mock.calls[1][0].where).toMatchObject({ slug: "client-slug" });
    expect(m.org.mock.calls[1][0].where).not.toHaveProperty("OR");
  });
});

describe("site shell is not authority for its children", () => {
  it.each([Overview, Apps, Sources, Settings])("retains the organization guard in %s", async (Page) => {
    expect(await draw()).toContain("Site-scoped content access");
    await expect(Page({ params })).rejects.toSatisfy(isNotFound);
    expect(m.workspace).toHaveBeenCalledWith(clientId, expect.objectContaining({ userId }));
    expect(m.sites).not.toHaveBeenCalled(); expect(m.overview).not.toHaveBeenCalled();
    expect(m.github).not.toHaveBeenCalled(); expect(m.sources).not.toHaveBeenCalled();
  });

  it("keeps organization schema preview denied and team redirect pointed at guarded overview", async () => {
    await expect(ContentPreview({ params })).rejects.toSatisfy(isNotFound);
    await expect(Team({ params })).rejects.toSatisfy((error: unknown) => isRedirect(error, `/clients/${clientId}`));
    expect(m.orgCaps).toHaveBeenCalledWith(userId, clientId);
  });

  it.each(["no grant", "wrong organization", "wrong dataset"])("denies dataset %s despite parent shell access", async (kind) => {
    expect(await draw()).toContain("Site-scoped content access");
    m.datasetCaps.mockResolvedValue({ scope: "dataset", datasetId: kind === "wrong dataset" ? id(99) : datasetId,
      organizationId: kind === "wrong organization" ? id(99) : clientId, canRead: kind !== "no grant" });
    await expect(Dataset({ params: Promise.resolve({ clientId, datasetId }), searchParams: Promise.resolve({}) })).rejects.toSatisfy(isNotFound);
    expect(m.documents).not.toHaveBeenCalled();
  });

  it("requires review of new child pages rather than silently assuming they have guards", () => {
    const root = fileURLToPath(new URL("../app/(platform)/clients/[clientId]/", import.meta.url));
    const pages = readdirSync(root, { recursive: true }).map(String)
      .map((path) => path.replaceAll("\\", "/")).filter((path) => path.endsWith("page.tsx")).sort();
    expect(pages).toEqual(["apps/page.tsx", "content/[datasetId]/page.tsx", "content/page.tsx", "page.tsx", "settings/page.tsx", "sources/page.tsx", "team/page.tsx"]);
  });
});