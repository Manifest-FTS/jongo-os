import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canManageInfrastructure, canViewInfrastructure, type RbacPrincipal } from "./rbac";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
const h = vi.hoisted(() => ({ pathname: "/dashboard", active: false, state: undefined as any }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useId: () => h.active ? "nav-test" : actual.useId(),
    useState: <T,>(initial: T) => {
      if (!h.active) return actual.useState(initial);
      if (h.state === undefined) h.state = initial;
      return [h.state, (value: T | ((previous: T) => T)) => {
        h.state = typeof value === "function" ? (value as (previous: T) => T)(h.state) : value;
      }];
    }
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
import PlatformPrimaryNav from "@/components/navigation/PlatformPrimaryNav";

beforeEach(() => {
  vi.stubGlobal("React", React);
  h.pathname = "/dashboard";
  h.active = false;
  h.state = undefined;
});
afterEach(() => vi.unstubAllGlobals());

describe("financial navigation and infrastructure policy", () => {
  it("omits billing navigation by default while retaining technical domains", () => {
    const html = renderToStaticMarkup(<PlatformPrimaryNav />);
    expect(html).not.toContain('href="/client-billing"');
    expect(html).not.toContain('href="/super-admin/access"');
    expect(html).toContain('href="/managed-domains"');
    expect(html).toContain('href="/my-domains"');
  });
  it("renders billing navigation only with the server-resolved capability", () => {
    expect(renderToStaticMarkup(<PlatformPrimaryNav canViewBilling />)).toContain('href="/client-billing"');
    expect(renderToStaticMarkup(<PlatformPrimaryNav canViewBilling />)).toContain('href="/super-admin/access"');
  });
  it("requires resource scope for a collaborator", () => {
    const user: RbacPrincipal = { userId: "user", email: "user@example.com", role: "collaborator", isPlatformAdmin: false };
    expect(canManageInfrastructure(user)).toBe(false);
    expect(canViewInfrastructure(user)).toBe(false);
    expect(canViewInfrastructure(user, true)).toBe(true);
    expect(canViewInfrastructure(null, true)).toBe(false);
    expect(canManageInfrastructure({ ...user, role: "admin", isPlatformAdmin: true })).toBe(true);
  });
});

function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap((child) => React.isValidElement<any>(child)
    ? [child, ...elements(child.props.children)] : []);
}
function branch(label: string, canViewBilling = false) {
  const all = elements(PlatformPrimaryNav({ canViewBilling }));
  const button = all.find((node) => node.type === "button" && node.props["aria-label"].endsWith(` ${label}`))!;
  const panel = all.find((node) => node.props.id === button.props["aria-controls"])!;
  const wrapper = all.find((node) => node.type === "li" && elements(node.props.children).some((child) =>
    child.type === "button" && child.props["aria-controls"] === button.props["aria-controls"]))!;
  return { all, button, panel, wrapper };
}

describe("nested primary navigation", () => {
  it("retains every original raw href and only links implemented routes", () => {
    const html = renderToStaticMarkup(<PlatformPrimaryNav canViewBilling />);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    const original = ["/dashboard", "/clients", "/apps", "/my-domains", "/managed-domains", "/client-billing", "/super-admin/access", "/usage", "/settings", "/notifications"];
    expect([...new Set(hrefs)].sort()).toEqual(original.sort());
    for (const href of hrefs) {
      expect(existsSync(new URL(`../app/(platform)${href}/page.tsx`, import.meta.url))).toBe(true);
    }
    expect(html).toContain(">My domains</span>");
    expect(html).toContain(">Profile</span>");
    expect(html).not.toMatch(/role="(?:menu|menuitem|tree|treeitem)"|tabindex=/);
  });

  it("uses separate links/buttons, initially hidden lists, visible chevrons, and collision-free controls", () => {
    const html = renderToStaticMarkup(<><PlatformPrimaryNav /><PlatformPrimaryNav /></>);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(4);
    for (const match of html.matchAll(/aria-controls="([^"]+)"/g)) expect(ids).toContain(match[1]);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(4);
    expect(html.match(/hidden=""/g)).toHaveLength(4);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*<svg[^>]*aria-hidden="true"/);
    expect(html).not.toMatch(/<a[^>]*>[^<]*<button/);
  });

  it.each([
    ["/my-domains", "Domains", "/my-domains"],
    ["/managed-domains/example", "Domains", "/managed-domains"],
    ["/settings", "Settings", "/settings"],
    ["/notifications", "Settings", "/notifications"],
    ["/client-billing/example", "Settings", "/client-billing"],
    ["/super-admin/access", "Settings", "/super-admin/access"]
  ])("reveals %s and marks only its most-specific leaf current", (path, label, href) => {
    h.active = true;
    h.pathname = path;
    const { all, button, panel } = branch(label, true);
    expect(button.props["aria-expanded"]).toBe(true);
    expect(panel.props.hidden).toBe(false);
    const current = all.filter((node) => node.props["aria-current"] === "page");
    expect(current).toHaveLength(1);
    expect(current[0].props.href).toBe(href);
    expect(elements(panel).some((node) => node.props.href === href && node.props["aria-current"] === "page")).toBe(true);
  });

  it("does not expand or mark a branch on a false prefix or unauthorized route", () => {
    h.active = true;
    h.pathname = "/settings-other";
    expect(branch("Settings").button.props["aria-expanded"]).toBe(false);
    expect(branch("Settings").all.filter((node) => node.props["aria-current"])).toHaveLength(0);
    h.pathname = "/client-billing";
    const { all, button } = branch("Settings");
    expect(button.props["aria-expanded"]).toBe(false);
    expect(all.some((node) => node.props.href === "/client-billing" || node.props.href === "/super-admin/access")).toBe(false);
  });

  it("lets the user collapse the active branch across rerenders and reopens on navigation", () => {
    h.active = true;
    h.pathname = "/managed-domains";
    branch("Domains").button.props.onClick();
    expect(branch("Domains").panel.props.hidden).toBe(true);
    expect(branch("Domains").button.props["aria-expanded"]).toBe(false);
    h.pathname = "/managed-domains/example";
    expect(branch("Domains").panel.props.hidden).toBe(false);
    branch("Domains").button.props.onClick();
    expect(branch("Domains").panel.props.hidden).toBe(true);
    branch("Domains").button.props.onClick();
    expect(branch("Domains").panel.props.hidden).toBe(false);
  });

  it("collapses on Escape from a child and returns focus to the native toggle", () => {
    h.active = true;
    h.pathname = "/notifications";
    const focus = vi.fn();
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn(),
      currentTarget: { querySelector: vi.fn(() => ({ focus })) } };
    branch("Settings").wrapper.props.onKeyDown(event);
    expect(branch("Settings").panel.props.hidden).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.currentTarget.querySelector).toHaveBeenCalledWith("button");
    branch("Settings").wrapper.props.onKeyDown(event);
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each(["Tab", "Enter", " "])("leaves %s to native link/button keyboard behavior", (key) => {
    h.active = true;
    const event = { key, preventDefault: vi.fn() };
    const { button, wrapper } = branch("Settings");
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    expect(button.props.onKeyDown).toBeUndefined();
    wrapper.props.onKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("scopes full-width lists, 44px controls, hidden panels, and soft active overrides", () => {
    const css = postcss.parse(readFileSync(new URL("../components/navigation/PlatformPrimaryNav.module.css", import.meta.url), "utf8"));
    const rules = new Map<string, Record<string, string>>();
    css.walkRules((rule) => {
      if (rule.parent?.type === "atrule") return;
      const declarations: Record<string, string> = {};
      rule.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
      rules.set(rule.selector, declarations);
    });
    expect(rules.get('.root .children[hidden]')?.display).toBe("none");
    expect(rules.get('.root .toggle')?.["min-height"]).toBe("44px");
    expect(rules.get('.root .toggle')?.width).toBe("44px");
    expect(rules.get('.root .branchLink:global(.app-nav-item)')?.["min-height"]).toBe("44px");
    const lists = [...rules].find(([selector]) => selector.includes(".items:global(.app-nav-items)"))![1];
    expect(lists.display).toBe("grid");
    expect(lists.width).toBe("100%");
    const active = [...rules].find(([selector]) => selector.includes('[data-active="true"]'))![1];
    expect(active.background).toBe("rgb(43 85 255 / 12%)");
    expect(active["box-shadow"]).toBe("none");
    expect(css.toString()).toContain(":focus-visible");
    expect(css.toString()).toContain("forced-colors: active");
  });
});