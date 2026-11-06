import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest compiles tsx with the classic runtime (tsconfig keeps jsx: preserve for Next).
(globalThis as { React?: unknown }).React = React;

const mocks = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), resolveManager: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: mocks.auth }));
vi.mock("@/lib/repositories", () => ({ getSiteWorkspace: mocks.workspace }));
vi.mock("@/lib/craft-admin/gate", () => ({ resolveCraftManager: mocks.resolveManager }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/lib/coolify", () => ({ getCoolifyAppStagingCapability: async () => null, getCoolifyOverview: async () => ({ mode: "mock", generatedAt: new Date().toISOString() }) }));
vi.mock("@/lib/site-source", () => ({ loadSiteSource: async () => null }));
vi.mock("@/lib/db", () => ({ getDb: async () => null, db: {} }));
vi.mock("@/lib/permissions", () => ({
  resolveSitePermissionSnapshot: async () => ({ canViewInternalMetadata: false, canDeleteSite: false, canFlushCache: false, canDeployFromGithub: false, canPromoteStaging: false })
}));
for (const name of ["SiteInfoForm", "SiteStagingToggle", "WordPressAdvancedControls", "SiteDangerZone", "SiteSourceCard", "PageAutoRefresh"]) {
  vi.doMock(`@/components/${name}`, () => ({ default: () => null }));
}

import CraftAccessPanel from "@/components/CraftAccessPanel";
import CraftClientSection from "@/components/CraftClientSection";
import SiteCollaboratorManager from "@/components/SiteCollaboratorManager";
import TeamPage from "@/app/(platform)/sites/[siteId]/team/page";
import type { CraftAccessPayload, CraftClientPayload } from "@/lib/craft-admin/shared";

const SITE = "30000000-0000-4000-8000-000000000001";

const access: CraftAccessPayload = {
  siteId: SITE,
  roles: [{ value: "reader", label: "Reader" }, { value: "editor", label: "Editor" }, { value: "publisher", label: "Publisher" }, { value: "admin", label: "Admin" }],
  maxGrantableRole: "admin",
  explicit: [{ userId: "u1", email: "ed@example.com", name: "Ed Itor", role: "editor", grantedBy: { email: "owner@example.com", name: "Olive Owner" }, createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" }],
  inherited: [
    { source: "platform_admin", label: "Jongo Super Admin", role: "admin", userId: null, email: null, name: null, contacts: ["support@jongo.example"] },
    { source: "org_owner", label: "Owner (inherited admin)", role: "admin", userId: "o1", email: "owner@example.com", name: "Olive Owner" }
  ]
};
const client: CraftClientPayload = {
  siteId: SITE, issuer: "https://jongo.example",
  client: {
    clientId: "jc_AAAAAAAAAAAAAAAAAAAAAA", name: "Golf Lab Craft", datasetName: "production", status: "active",
    redirectUris: ["https://golf.example/craft/auth/callback"], allowedOrigins: ["https://golf.example"],
    createdAt: "2026-11-01T00:00:00Z", rotatedAt: null, disabledAt: null, previousSecretValidUntil: null
  }
};
const noop = () => undefined;

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("Jongo Craft panel markup", () => {
  const html = renderToStaticMarkup(<CraftAccessPanel siteId={SITE} initial={{ access, client }} />);

  it("renders the access table with labelled controls and read-only inherited rows", () => {
    expect(html).toContain("Jongo Craft");
    expect(html).toContain("<caption");
    expect(html).toContain('aria-label="Craft role for Ed Itor"');
    expect(html).toContain('aria-label="Revoke Craft access for Ed Itor"');
    expect(html).toContain("2026-11-03 by Olive Owner");
    expect(html).toContain("Jongo Super Admin");
    expect(html).toContain("support@jongo.example");
    expect(html).toContain("Read-only here");
    // Exactly one role select per explicit row plus the add form: inherited rows have none.
    expect((html.match(/aria-label="Craft role for /g) ?? []).length).toBe(1);
  });

  it("has a labelled add-by-email form and a polite live region", () => {
    expect(html).toMatch(/<label[^>]*>Add a person by email<\/label>/);
    expect(html).toMatch(/<label[^>]*>Role<\/label>/);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("They need a Jongo account already");
  });

  it("shows the client without any secret, and the env snippet with names and a placeholder", () => {
    expect(html).toContain("jc_AAAAAAAAAAAAAAAAAAAAAA");
    for (const name of ["CRAFT_SSO_ENABLED", "CRAFT_SSO_ISSUER", "CRAFT_SSO_CLIENT_ID", "CRAFT_SSO_CLIENT_SECRET", "CRAFT_SSO_REDIRECT_URI"]) expect(html).toContain(name);
    expect(html).toContain("CRAFT_SSO_ISSUER=https://jongo.example");
    expect(html).toContain("CRAFT_SSO_CLIENT_SECRET=&lt;paste the client secret from the one-time reveal&gt;");
    expect(html).not.toMatch(/jcs_|secretHash|v1\$/);
    expect(html).toContain("Rotate secret");
    expect(html).toContain("Disable client");
    expect(html).not.toContain("shown only once");
  });

  it("every form control has an associated label", () => {
    const ids = [...html.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) expect(html, id).toContain(`for="${id}"`);
  });
});

describe("Jongo Craft client section", () => {
  it("without a client: a create form with the redirect URI and dataset fields", () => {
    const markup = renderToStaticMarkup(<CraftClientSection siteId={SITE} initial={{ siteId: SITE, client: null, issuer: null }} onStatus={noop} />);
    expect(markup).toContain("Create client");
    expect(markup).toMatch(/<label[^>]*>Redirect URIs<\/label>/);
    expect(markup).toMatch(/<label[^>]*>Craft dataset name<\/label>/);
    expect(markup).not.toContain("Environment for your site");
    expect(markup).not.toContain("Rotate secret");
  });

  it("a disabled client offers Enable and no rotation", () => {
    const disabled = { ...client, client: { ...client.client!, status: "disabled" as const, disabledAt: "2026-11-05T00:00:00Z" } };
    const markup = renderToStaticMarkup(<CraftClientSection siteId={SITE} initial={disabled} onStatus={noop} />);
    expect(markup).toContain("Enable client");
    expect(markup).not.toContain("Rotate secret");
    expect(markup).toContain("degraded");
  });

  it("shows a previous-secret overlap date after a rotation", () => {
    const rotated = { ...client, client: { ...client.client!, rotatedAt: "2026-11-05T00:00:00Z", previousSecretValidUntil: "2026-11-06T00:00:00Z" } };
    const markup = renderToStaticMarkup(<CraftClientSection siteId={SITE} initial={rotated} onStatus={noop} />);
    expect(markup).toContain("Previous secret works until");
    expect(markup).toContain("2026-11-06");
  });
});

describe("app invite control", () => {
  const baseline = renderToStaticMarkup(<SiteCollaboratorManager siteId={SITE} currentUserId="u" />);

  it("without the craft prop (flag off) nothing about Craft is rendered", () => {
    expect(baseline).not.toMatch(/craft/i);
  });

  it("a viewer who may not grant Craft access sees exactly the original markup", () => {
    const withoutRights = renderToStaticMarkup(<SiteCollaboratorManager siteId={SITE} currentUserId="u" craft={{ canGrant: false }} />);
    expect(withoutRights).toBe(baseline);
  });

  it("a manager gets a labelled select: No Craft access (default), Reader, Editor, Publisher, Admin, with help text", () => {
    const markup = renderToStaticMarkup(<SiteCollaboratorManager siteId={SITE} currentUserId="u" craft={{ canGrant: true }} />);
    expect(markup).toContain("Jongo Craft access");
    const options = [...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(options).toEqual(expect.arrayContaining(["none:No Craft access", "reader:Reader", "editor:Editor", "publisher:Publisher", "admin:Admin"]));
    const craftSelect = /<select id="([^"]+-craft)"[^>]*aria-describedby="([^"]+)"[^>]*>(.*?)<\/select>/.exec(markup)!;
    expect(craftSelect[3].startsWith('<option value="none" selected="">No Craft access</option>') || craftSelect[3].startsWith('<option value="none">No Craft access</option>')).toBe(true);
    expect(markup).toContain(`for="${craftSelect[1]}"`);
    expect(markup).toContain(`id="${craftSelect[2]}"`);
    expect(markup).toContain("Only the client owner and admins can set this.");
    // Everything the original form had is still there, in order, minus the one inserted block.
    expect(markup.replace(/<div style="flex:1 1 100%">.*?<\/div>/, "")).toBe(baseline);
  });
});

describe("pages: flag off renders nothing new and looks nothing up", () => {
  const workspace = {
    id: SITE, clientId: "client-1", source: "db", name: "Golf Lab", siteType: "app", resourceType: "App", ownershipState: "mapped",
    stagingEnabled: false, description: null, coolifyServiceUuid: null, coolifyProjectId: null, slug: "golf", gitRepositoryUrl: null
  };
  const find = (node: unknown, type: unknown, found: any[] = []): any[] => {
    if (Array.isArray(node)) node.forEach((child) => find(child, type, found));
    else if (React.isValidElement(node)) {
      if (node.type === type) found.push(node);
      find((node.props as { children?: unknown }).children, type, found);
    }
    return found;
  };

  beforeEach(() => {
    mocks.auth.mockResolvedValue({ user: { id: "u1", email: "u@example.com" } });
    mocks.workspace.mockResolvedValue(workspace);
    mocks.resolveManager.mockResolvedValue({ ok: true });
  });

  it.each(["undefined", "", "false", "TRUE", "1"])("team page, JONGO_OIDC_ENABLED=%j", async (value) => {
    if (value !== "undefined") vi.stubEnv("JONGO_OIDC_ENABLED", value);
    const tree = await TeamPage({ params: Promise.resolve({ siteId: SITE }) });
    expect(find(tree, SiteCollaboratorManager)).toEqual([]);
    expect(mocks.resolveManager).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).not.toMatch(/craft/i);
  });

  it("team page: flag on and a manager gets the Craft-aware invite form; a non-manager does not", async () => {
    vi.stubEnv("JONGO_OIDC_ENABLED", "true");
    const withManager = await TeamPage({ params: Promise.resolve({ siteId: SITE }) });
    expect(find(withManager, SiteCollaboratorManager)).toHaveLength(1);
    expect(find(withManager, SiteCollaboratorManager)[0].props).toMatchObject({ siteId: SITE, craft: { canGrant: true } });
    expect(mocks.resolveManager).toHaveBeenCalledWith("u1", SITE);

    mocks.resolveManager.mockResolvedValue({ ok: false, status: 403 });
    const withoutManager = await TeamPage({ params: Promise.resolve({ siteId: SITE }) });
    expect(find(withoutManager, SiteCollaboratorManager)).toEqual([]);
    expect(renderToStaticMarkup(withoutManager)).toBe(renderToStaticMarkup(await (async () => { vi.stubEnv("JONGO_OIDC_ENABLED", "false"); return TeamPage({ params: Promise.resolve({ siteId: SITE }) }); })()));
  });

  it("team page flag-off markup is stable (committed snapshot, identical to the pre-Craft page)", async () => {
    const tree = await TeamPage({ params: Promise.resolve({ siteId: SITE }) });
    expect(renderToStaticMarkup(tree)).toMatchSnapshot();
  });

  it("settings page: no panel and no lookup with the flag off; panel only for a manager with the flag on", async () => {
    const { default: SettingsPage } = await import("@/app/(platform)/sites/[siteId]/settings/page");
    const off = await SettingsPage({ params: Promise.resolve({ siteId: SITE }) });
    expect(find(off, CraftAccessPanel)).toEqual([]);
    expect(mocks.resolveManager).not.toHaveBeenCalled();

    vi.stubEnv("JONGO_OIDC_ENABLED", "true");
    const on = await SettingsPage({ params: Promise.resolve({ siteId: SITE }) });
    expect(find(on, CraftAccessPanel)).toHaveLength(1);
    expect(find(on, CraftAccessPanel)[0].props).toEqual({ siteId: SITE });

    mocks.resolveManager.mockResolvedValue({ ok: false, status: 403 });
    expect(find(await SettingsPage({ params: Promise.resolve({ siteId: SITE }) }), CraftAccessPanel)).toEqual([]);
  });
});
