import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it, vi } from "vitest";
import PlatformBrandFooter from "./PlatformBrandFooter";

vi.mock("next/font/google", () => ({ Josefin_Sans: () => ({ variable: "font-jongo-wordmark" }) }));

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const css = postcss.parse(source("./PlatformBrandFooter.module.css"));
function declarations(selector: string) {
  const values: Record<string, string> = {};
  css.walkRules((rule) => {
    if (rule.selector === selector && rule.parent?.type === "root") {
      rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
    }
  });
  return values;
}

describe("Jongo platform footer", () => {
  it("renders Jongo's own dashboard lockup and workspace settings link", () => {
    const html = renderToStaticMarkup(<PlatformBrandFooter />);
    expect(html).toContain('aria-label="Jongo platform footer"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('aria-label="Jongo dashboard home"');
    expect(html).toContain('/assets/brand/jongo-logomark-color.svg');
    expect(html).toContain('class="jongo-brand-wordmark" aria-hidden="true">Jongo</span>');
    expect(html).toContain('aria-label="Jongo footer links"');
    expect(html).toContain('href="/settings">Workspace settings</a>');
    expect(html).not.toMatch(/Manifest|MANIFEST|FTS|seal|tagline|Pause|animation/i);
  });

  it("keeps the footer compact, bottom-aligned, spaced, and responsive", () => {
    expect(declarations(".footer")).toMatchObject({
      display: "flex", "align-items": "center", "margin-top": "auto", padding: "0.7rem 1rem",
      background: "#1a1a1a", color: "#ffffff", "border-radius": "10px"
    });
    expect(declarations(".footer").gap).toBe("0.75rem 1.5rem");
    expect(declarations(".links")).toMatchObject({ display: "flex", "flex-wrap": "wrap" });
    expect(declarations(".footer :is(a, button):focus-visible").outline).toBe("2px solid var(--platform-focus)");
    expect(source("../../app/globals.css")).toMatch(/\.app-shell\s*\{[^}]*min-height:\s*100svh/s);
    expect(source("../../app/globals.css")).toMatch(/\.app-main\s*\{[^}]*flex-direction:\s*column/s);
    expect(source("../../app/globals.css")).toMatch(/\.app-content\s*\{[^}]*margin-bottom:\s*1\.5rem/s);
    expect(css.toString()).not.toMatch(/animation|manifest-m-original|FORWARD THINKING|Pause/i);
  });
});
