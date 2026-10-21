import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ active: false, useState: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => hooks.active ? hooks.useState(initial) : actual.useState(initial) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: hooks.refresh }) }));
import MarketingAdminControls, { type MarketingAdminControlsProps } from "./MarketingAdminControls";

const token = `jcms_${"t".repeat(43)}`;
const revisionId = "10000000-0000-4000-8000-000000000007";
const props = (): MarketingAdminControlsProps => ({
  publication: { status: "active", revision: 4, hasRelease: true },
  revisions: [{ id: revisionId, type: "article", label: "saved-article" }],
  credentials: [{ id: "10000000-0000-4000-8000-000000000008", prefix: "jcms:display", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null, revokedAt: null }],
  canPublish: true, canManage: true,
  actions: { publish: vi.fn().mockResolvedValue({ status: "ok", publicationRevision: 5 }),
    unpublish: vi.fn().mockResolvedValue({ status: "ok", publicationRevision: 6 }),
    mint: vi.fn().mockResolvedValue({ status: "ok", token, credentialId: "10000000-0000-4000-8000-000000000009" }),
    revoke: vi.fn().mockResolvedValue({ status: "ok" }) }
});
let slots: unknown[] = [];
let cursor = 0;
const draw = (input = props()) => { cursor = 0; return MarketingAdminControls(input); };
const children = (node: React.ReactNode): React.ReactElement[] => !React.isValidElement(node) ? []
  : [node, ...React.Children.toArray(node.props.children).flatMap(children)];
const text = (node: React.ReactElement) => React.Children.toArray(node.props.children).map(child => typeof child === "string" ? child : "").join("");
beforeEach(() => {
  slots = []; cursor = 0; hooks.active = true; hooks.refresh.mockReset();
  hooks.useState.mockImplementation((initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[index]) : next; }];
  });
});
afterEach(() => { hooks.active = false; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dataset marketing admin controls", () => {
  it("shows non-technical release state, CAS revision and masked credential metadata", () => {
    const html = renderToStaticMarkup(<MarketingAdminControls {...props()} />);
    expect(html).toContain("Current status:"); expect(html).toContain("Published"); expect(html).toContain("Publication revision 4");
    expect(html).toContain("saved-article"); expect(html).toContain("jcms:display");
    expect(html).toContain("Create delivery credential"); expect(html).toContain("Unpublish website");
    expect(html).not.toMatch(/tokenHash|token=.*jcms_|sha256/i);
  });

  it("disables publish, unpublish, mint and revoke when current capability is absent", () => {
    const input = props(); input.canPublish = false; input.canManage = false;
    const html = renderToStaticMarkup(<MarketingAdminControls {...input} />);
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Publishing is disabled for your access");
    expect(html).toContain("Credential management is disabled for your access");
  });

  it("publishes selected saved revisions with the page's current publication revision", async () => {
    const input = props();
    let tree = draw(input);
    const nodes = children(tree);
    const checkboxes = nodes.filter(node => node.type === "input" && node.props.type === "checkbox");
    checkboxes[1].props.onChange({ target: { checked: true } });
    tree = draw(input);
    const publish = children(tree).find(node => node.type === "button" && text(node) === "Publish selected drafts")!;
    expect(publish.props.disabled).toBe(false);
    await publish.props.onClick();
    await Promise.resolve(); await Promise.resolve();
    expect(input.actions.publish).toHaveBeenCalledWith({ revisionIds: [revisionId], expectedRevision: 4 });
    expect(hooks.refresh).toHaveBeenCalled();
  });

  it("keeps a minted token only in one-time component state and provides copy UI", async () => {
    const input = props();
    const button = () => children(draw(input)).find(node => node.type === "button" && text(node) === "Create delivery credential")!;
    await button().props.onClick();
    await Promise.resolve(); await Promise.resolve();
    const html = renderToStaticMarkup(draw(input));
    expect(html).toContain(token);
    expect(html).toContain("Copy token");
    expect(html.toLowerCase()).toContain("it will not be shown again");
    expect(input.actions.mint).toHaveBeenCalledTimes(1);
  });

  it("shows only generic errors and handles an unavailable metadata load", () => {
    const input = props(); input.loadError = true;
    input.actions.publish = vi.fn().mockResolvedValue({ status: "unavailable" });
    const html = renderToStaticMarkup(<MarketingAdminControls {...input} />);
    expect(html).toContain("details are unavailable");
    expect(html).not.toContain("PRIVATE");
  });
});
