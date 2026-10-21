import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Test loader definitions without invoking Next's build-time Google fetch.
vi.mock("next/font/google", () => ({ Josefin_Sans: () => ({ variable: "mock-wordmark" }) }));
import JongoBrandLockup from "./JongoBrandLockup";

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const layout = source("../../app/(platform)/layout.tsx");
const rootLayout = source("../../app/layout.tsx");
const dashboard = source("../../app/(platform)/dashboard/page.tsx");
const brand = source("./JongoBrandLockup.tsx");
const css = postcss.parse(source("../../styles/brand-platform.css"));
const scope = '[data-platform-theme="light"]';
const normalizeSelector = (selector: string) => selector.replace(/\s+/g, " ").trim();

function declarations(selector: string) {
  const values: Record<string, string> = {};
  css.walkRules((rule) => {
    if (normalizeSelector(rule.selector) === normalizeSelector(selector)) rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
  });
  return values;
}

function loaderOptions(text: string, name: string) {
  const file = ts.createSourceFile("font.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result: Record<string, string | string[]> | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === name) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        result = {};
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const value = prop.initializer;
          if (ts.isStringLiteral(value)) result[prop.name.getText(file)] = value.text;
          if (ts.isArrayLiteralExpression(value)) result[prop.name.getText(file)] = value.elements.map((item) => (item as ts.StringLiteral).text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

const tokens: Record<string, string> = {};
css.walkRules((rule) => {
  if (rule.selector === scope) rule.walkDecls((decl) => { tokens[decl.prop] = decl.value; });
});
function contrast(a: string, b: string) {
  function luminance(hex: string) {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("platform-only shell brand contract", () => {
  it("gates every CSS selector, including responsive/a11y overrides, on the platform wrapper", () => {
    css.walkRules((rule) => {
      // PostCSS respects commas nested in :is(), unlike String.split(',').
      for (const selector of rule.selectors) expect(selector.startsWith(scope)).toBe(true);
    });
    expect(css.nodes.some((node) => node.type === "atrule" && ["import", "font-face"].includes(node.name))).toBe(false);
    expect(layout).toContain('data-platform-theme="light"');
    expect(layout).not.toContain('data-platform-theme="dark"');
    expect(css.toString()).not.toContain('[data-platform-theme="dark"]');
    expect(layout).toContain('import "@/styles/brand-platform.css"');
    expect(rootLayout).not.toContain("brand-platform");
    expect(rootLayout).not.toContain("data-platform-theme");
    expect(rootLayout).toContain('colorScheme: "only light"');
    expect(layout).toContain('colorScheme: "light", themeColor: "#fafafa"');
  });

  it("loads Josefin 600 for stats only, retains DM headings and preserves the separate logo font", () => {
    expect(loaderOptions(layout, "DM_Sans")).toMatchObject({ weight: ["500", "700"], display: "swap", subsets: ["latin"] });
    expect(loaderOptions(layout, "Inter")).toMatchObject({ weight: ["400", "500", "600", "700"], display: "swap" });
    expect(loaderOptions(brand, "Josefin_Sans")).toMatchObject({ weight: "600", display: "swap" });
    expect(loaderOptions(layout, "Josefin_Sans")).toMatchObject({
      weight: "600", display: "swap", subsets: ["latin"], variable: "--font-platform-stat"
    });
    expect(layout).toContain("platformHeadings.variable");
    expect(layout).toContain("platformBody.variable");
    expect(layout).toContain("platformStats.variable");
    expect(layout).toMatch(/data-platform-theme="light" className=\{`app-shell[^`]*\$\{platformStats.variable\}/);
    const headingRules: string[] = [];
    css.walkRules((rule) => {
      if (rule.selector.includes("h1")) rule.walkDecls("font-family", (decl) => { headingRules.push(decl.value); });
    });
    expect(headingRules).toEqual(["var(--jongo-font-display)"]);
    expect(tokens["--jongo-font-display"]).toContain("--font-platform-heading");
    const statSelector = `${scope} :is(.metric-value, .health-stat-value, .metric-card > .metric-label)`;
    expect(declarations(statSelector)).toMatchObject({
      "font-family": 'var(--font-platform-stat, "Josefin Sans", sans-serif)', "font-weight": "600"
    });
    css.walkDecls("font-family", (decl) => {
      if (decl.value.includes("--font-platform-stat")) expect((decl.parent as postcss.Rule).selector).toBe(statSelector);
    });
  });

  it("renders the original mark with one accessible name and a neutral white 600 wordmark", () => {
    const previous = globalThis.React;
    vi.stubGlobal("React", React);
    try {
      const html = renderToStaticMarkup(<JongoBrandLockup />);
      expect(html).toContain('role="img" aria-label="Jongo"');
      expect(html).toContain('src="/assets/brand/jongo-logomark-color.svg"');
      expect(html).toContain('alt="" aria-hidden="true"');
      expect(html).toContain('class="jongo-brand-wordmark" aria-hidden="true">Jongo</span>');
      expect(html).not.toContain("manifest");
      const declarations: Record<string, string> = {};
      css.walkRules((rule) => {
        if (rule.selector === `${scope} .jongo-brand-wordmark`) rule.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
      });
      expect(declarations).toMatchObject({ color: "#ffffff", "font-weight": "600" });
    } finally {
      vi.unstubAllGlobals();
      if (previous !== undefined) globalThis.React = previous;
    }
  });

  it("retains server capability resolution, profile selection, navigation and account controls", () => {
    for (const fragment of [
      "const session = await auth();", "await isSuperAdminUser(session?.user?.id)",
      "select: { email: true, fullName: true, avatarUrl: true }",
      "<PlatformPrimaryNav canViewBilling={canViewBilling} />", "<NotificationBell />",
      "<SignOutButton />", "<DesktopNotificationPrompt />", '<details className="user-menu">',
      'href="/dashboard"', 'href="/settings"', '<div className="app-content">{children}</div>'
    ]) expect(layout).toContain(fragment);
  });

  it.each(["--bg", "--surface", "--surface-alt", "--surface-sunken"])("has AA primary/secondary text on %s", (surface) => {
    for (const foreground of ["--text", "--text-soft", "--muted", "--muted-strong"]) {
      expect(contrast(tokens[foreground], tokens[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses the exact flat light palette with locally inherited dark chrome", () => {
    expect(tokens).toMatchObject({
      "color-scheme": "light", "--bg": "#fafafa", "--surface": "#ffffff",
      "--text": "#1a1a1a", "--text-soft": "#505050", "--muted": "#505050",
      "--border": "#e5e5e5", "--accent": "#2b55ff", "--platform-blue": "#2b55ff",
      "--platform-highlight": "#d6ff38", "--platform-action-ink": "#ffffff",
      "--radius-sm": "8px", "--radius-md": "8px", "--radius-lg": "12px", "--radius-xl": "12px"
    });
    for (const shadow of ["--shadow", "--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg"]) expect(tokens[shadow]).toBe("none");
    const chrome = declarations(`${scope} :is(.app-sidebar, .app-topbar)`);
    expect(chrome).toMatchObject({
      "color-scheme": "dark", "--surface": "#121212", "--surface-alt": "#242424",
      "--text": "#ffffff", "--text-soft": "#ffffff", background: "var(--surface)", color: "var(--text)", "box-shadow": "none"
    });
    for (const surface of ["--surface", "--surface-alt", "--surface-sunken"]) {
      for (const ink of ["--text", "--text-soft", "--muted"]) expect(contrast(chrome[ink], chrome[surface])).toBeGreaterThanOrEqual(4.5);
    }
    expect(declarations(`${scope} .app-nav`)).toMatchObject({ background: "var(--surface)", color: "var(--text)", "box-shadow": "none" });
    expect(declarations(`${scope} :is(.topbar-icon-button, .user-menu-trigger)`)).toMatchObject({ background: "var(--surface-alt)", color: "var(--text)" });
    expect(declarations(`${scope} .user-menu-panel`)).toMatchObject({ background: "var(--surface)", color: "var(--text)" });
  });

  it("keeps blue actions/selection and semantic messages legible on the light workspace", () => {
    expect(contrast(tokens["--platform-action-ink"], tokens["--platform-blue"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["--platform-blue"], tokens["--surface"])).toBeGreaterThanOrEqual(4.5);
    expect(tokens["--platform-magenta"]).toBe("#d92b91");
    for (const foreground of ["--platform-success", "--platform-warning", "--platform-error"]) {
      expect(contrast(tokens[foreground], tokens["--surface"])).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens["--border-strong"], tokens["--surface-sunken"])).toBeGreaterThanOrEqual(3);
    expect(declarations(`${scope} :is(.app-nav-item, .nav-pill, .tab-link, .workspace-nav-item).is-active`)).toMatchObject({ background: "var(--platform-blue)", color: "#ffffff" });
    const focus = declarations(`${scope} :is(a, button, input, select, textarea, summary, [tabindex]):focus-visible`);
    expect(focus.outline).toBe("2px solid var(--platform-focus)");
    for (const background of ["#ffffff", "#fafafa"]) expect(contrast(tokens["--platform-focus"], background)).toBeGreaterThanOrEqual(3);
    const chrome = declarations(`${scope} :is(.app-sidebar, .app-topbar)`);
    for (const background of ["#121212", "#242424"]) expect(contrast(chrome["--platform-focus"], background)).toBeGreaterThanOrEqual(3);
    css.walkDecls((decl) => {
      if (decl.value.includes("var(--platform-highlight)")) {
        expect(decl.prop).toBe("background");
        expect((decl.parent as postcss.Rule).selector).toBe(`${scope} :is(.tag-highlight, .status-chip.highlight, .callout-banner)`);
      }
    });
    for (const [selector, background, foreground] of [
      [":is(.tag-mapped, .status-chip.healthy)", "#ecfdf3", "#027a48"],
      [":is(.tag-warning, .status-chip.degraded)", "#fffaeb", "#924600"],
      [".status-chip.error", "#fef3f2", "#b42318"]
    ]) {
      expect(declarations(`${scope} ${selector}`)).toMatchObject({ background, color: foreground });
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("colors the four actual dashboard metrics in order and leaves optional Offline neutral", () => {
    const file = ts.createSourceFile("dashboard.tsx", dashboard, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const className = (node: ts.JsxElement) => node.openingElement.attributes.properties
      .filter(ts.isJsxAttribute).find((attr) => attr.name.getText(file) === "className")?.initializer?.getText(file);
    let strip: ts.JsxElement | undefined;
    function visit(node: ts.Node) {
      if (ts.isJsxElement(node) && className(node) === '"metric-strip dashboard-metric-strip"') strip = node;
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(strip).toBeDefined();
    const cards = strip!.children.filter(ts.isJsxElement);
    expect(cards).toHaveLength(4);
    const colors = ["#effd96", "#e6ecff", "#fde8f0", "#fbf9f1"];
    for (const [i, card] of cards.entries()) {
      expect(className(card)).toBe('"card metric-card"');
      expect(card.getText(file)).toContain(["Apps", "Clients", "Team Members", "Healthy"][i]);
      expect(declarations(`${scope} .dashboard-metric-strip.metric-strip > .metric-card:nth-child(${i + 1})`).background).toBe(colors[i]);
      for (const ink of ["--text", "--muted"]) expect(contrast(tokens[ink], colors[i])).toBeGreaterThanOrEqual(4.5);
    }
    expect(strip!.getText(file)).toContain("unknownSites > 0");
    expect(strip!.getText(file)).toContain('className="card metric-card metric-card--compact"');
    expect(css.toString()).not.toContain("nth-child(5)");
  });

  it("keeps backup primary background, label and border above the secondary cascade", () => {
    const selector = `${scope} .bk-btn.bk-btn--primary`;
    expect(declarations(selector)).toEqual({ background: "var(--platform-blue)", color: "var(--platform-action-ink)", "border-color": "var(--platform-blue)" });
    expect(declarations(`${selector}:hover:not(:disabled)`)).toEqual({ background: "var(--accent-strong)", color: "var(--platform-action-ink)", "border-color": "var(--accent-strong)" });
    const rules: string[] = [];
    css.walkRules((rule) => { rules.push(rule.selector); });
    const secondary = `${scope} :is(.btn-secondary, .deploy-btn[data-env="staging"], .bk-btn, .directory-filter-trigger)`;
    expect(rules.indexOf(selector)).toBeGreaterThan(rules.indexOf(secondary));
    expect(rules.indexOf(`${selector}:hover:not(:disabled)`)).toBeGreaterThan(rules.indexOf(`${secondary}:hover:not(:disabled)`));
  });

  it("uses 12px surfaces and 8px controls without changing avatars or status dots", () => {
    css.walkDecls("border-radius", (decl) => {
      expect(["8px", "12px"]).toContain(decl.value);
      const selector = (decl.parent as postcss.Rule).selector;
      // Utility overrides explicitly exclude full circles and avatars.
      expect(selector.replace(/:not\(\.user-avatar\)/g, "")).not.toContain(".user-avatar");
      expect(selector.replace(/:not\(\.rounded-full\)/g, "")).not.toContain(".rounded-full");
      expect(selector).not.toContain("::before");
    });
    for (const selector of [
      ":is(.card, .page-hero, .workspace-hero, .metric-card--compact)",
      ":is(.app-sidebar, .app-topbar)", ".app-nav", ".user-menu-panel",
      ":is(.health-stat-block, .health-reconcile-note, .directory-filter-panel)"
    ]) expect(declarations(`${scope} ${selector}`)["border-radius"]).toBe("12px");
    // Dashboard metrics/activity/health panels inherit the .card surface rule.
    for (const name of ["metric-card", "dashboard-activity-panel", "dashboard-health-panel"]) {
      expect(dashboard).toContain(`className="card ${name}"`);
    }
    for (const selector of [
      ":is(.app-nav-item, .nav-pill, .tab-link)", ".workspace-nav-item",
      ":is(.topbar-icon-button, .user-menu-trigger)",
      ':is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), select, textarea)',
      ':is(.btn, .btn--primary, .deploy-btn[data-env="production"], .bk-btn--primary)',
      ':is(.btn-secondary, .deploy-btn[data-env="staging"], .bk-btn, .directory-filter-trigger)'
    ]) expect(declarations(`${scope} ${selector}`)["border-radius"]).toBe("8px");
    const smallUtilities = `${scope} .app-content :is(.rounded, .rounded-sm, .rounded-md):not(.rounded-full):not(.user-avatar)`;
    const panels = `${scope} .app-content :is(.rounded-lg, .rounded-xl, .rounded-2xl, .rounded-3xl,
  .bk-schedule, .diagnostic-banner, .workspace-nav, .workspace-tab-bar,
  .card a[style*="border-radius: 12px"], .card a[style*="border-radius:12px"]):not(.rounded-full):not(.user-avatar)`;
    expect(declarations(smallUtilities)["border-radius"]).toBe("8px");
    expect(declarations(panels)["border-radius"]).toBe("12px");
    const notificationPanels = `${scope} .topbar-actions [role="dialog"][aria-label="Notifications"],
${scope} > [role="status"]`;
    expect(declarations(notificationPanels)["border-radius"]).toBe("12px");
    for (const selector of [smallUtilities, panels, notificationPanels]) {
      css.walkRules((rule) => {
        if (normalizeSelector(rule.selector) === normalizeSelector(selector)) rule.walkDecls("border-radius", (decl) => { expect(decl.important).toBe(true); });
      });
    }
    css.walkDecls("box-shadow", (decl) => { expect(decl.value).toBe("none"); });
    expect(css.toString()).toContain(".shadow-card-sm");
  });

  it("explicitly removes logo link and descendant wordmark decoration in every state", () => {
    for (const state of ["", ":hover", ":focus", ":focus-visible", ":active", ":visited"]) {
      for (const descendant of ["", " .jongo-brand-wordmark"]) {
        const selector = `${scope} .topbar-logo${state}${descendant}`;
        const rules: postcss.Rule[] = [];
        css.walkRules((rule) => { if (rule.selectors.includes(selector)) rules.push(rule); });
        expect(rules.length, selector).toBeGreaterThan(0);
        for (const rule of rules) expect(declarations(rule.selector)["text-decoration"]).toBe("none");
      }
    }
    expect(declarations(`${scope} .jongo-brand-lockup`)["text-decoration"]).toBe("none");
    expect(declarations(`${scope} .jongo-brand-wordmark`)).toMatchObject({
      "font-family": 'var(--font-jongo-wordmark, "Josefin Sans", sans-serif)', "font-weight": "600"
    });
  });

  it("explicitly covers legacy hardcoded shell surfaces, fields, focus and reflow", () => {
    const selectors: string[] = [];
    css.walkRules((rule) => { selectors.push(rule.selector); });
    const all = selectors.join("\n");
    for (const name of [".app-shell", ".card", ".app-nav-item", ".workspace-hero", ".tab-link", ".nav-pill", ".user-menu-panel", ".btn-secondary", ".btn-danger", ".form-label", "textarea", ":focus-visible"]) expect(all).toContain(name);
    expect(css.toString()).toContain("min-height: 44px");
    expect(css.toString()).toContain("prefers-reduced-motion: reduce");
    expect(css.toString()).toContain("forced-colors: active");
    expect(css.toString()).toContain("grid-template-columns: minmax(0, 1fr)");
    // The primary :is() contains an attribute selector (deploy environment).
    // Danger needs two classes to avoid inheriting blue at higher specificity.
    expect(all).toContain(":is(.btn.btn-danger, .bk-btn.bk-btn--danger)");
  });
});