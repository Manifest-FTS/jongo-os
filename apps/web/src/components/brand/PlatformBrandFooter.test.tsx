import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import PlatformBrandFooter from "./PlatformBrandFooter";

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
  it("renders only Jongo and workspace links, without Manifest branding", () => {
    const html = renderToStaticMarkup(<PlatformBrandFooter />);
    expect(html).toContain('aria-label="Jongo platform footer"');
    expect(html).toContain('aria-label="Jongo footer links"');
    expect(html).toContain('href="https://jongo.app">Jongo');
    expect(html).toContain('href="/settings">Workspace settings</a>');
    expect(html.match(/aria-hidden="true">↗/g)).toHaveLength(1);
    expect(html).not.toMatch(/Manifest|MANIFEST|FTS|seal|tagline|Pause/);
  });

  it("keeps the footer compact and responsive with visible keyboard focus", () => {
    expect(declarations(".footer")).toMatchObject({
      "margin-top": "auto", padding: "0.75rem 1rem", background: "#1a1a1a", color: "#ffffff"
    });
    expect(declarations(".links")).toMatchObject({ display: "flex", "flex-wrap": "wrap", "justify-content": "flex-end" });
    expect(declarations(".footer.footer :is(a, button):focus-visible").outline).toBe("2px solid #8096ff");
    expect(css.toString()).not.toMatch(/animation|manifest-m-original|FORWARD THINKING/i);
  });
});