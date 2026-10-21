import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ active: false, paused: false }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useId: () => hooks.active ? ":test:footer:" : actual.useId(),
    useState: (initial: boolean) => hooks.active
      ? [hooks.paused, (update: (previous: boolean) => boolean) => { hooks.paused = update(hooks.paused); }]
      : actual.useState(initial)
  };
});
import PlatformBrandFooter from "./PlatformBrandFooter";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const css = postcss.parse(source("./PlatformBrandFooter.module.css"));
const component = source("./PlatformBrandFooter.tsx");
function declarations(selector: string) {
  const values: Record<string, string> = {};
  css.walkRules((rule) => {
    if (rule.selector === selector && rule.parent?.type === "root") {
      rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
    }
  });
  return values;
}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap((child) => React.isValidElement<any>(child)
    ? [child, ...elements(child.props.children)] : []);
}

beforeEach(() => { hooks.active = false; hooks.paused = false; });
afterEach(() => { hooks.active = false; vi.restoreAllMocks(); });

describe("PlatformBrandFooter static brand contract", () => {
  it("SSR renders the Manifest-only title-case lockup and exact tagline", () => {
    const html = renderToStaticMarkup(<PlatformBrandFooter />);
    expect(html).toContain('<footer');
    expect(html).toContain('role="img" aria-label="Manifest"');
    expect(html).toContain('aria-hidden="true">Manifest</span>');
    expect(html).toContain("Forward thinking.<br/>Thoughtfully made.");
    expect(html).toContain('data-tone="lime"');
    expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/Manifest FTS|ManifestFTS|sponsor|github|posts/i);
    expect(html).not.toContain("app-footer");
    expect(html).not.toContain(">MANIFEST<");
  });

  it("uses the approved original M without redrawing its geometry", () => {
    const asset = source("../../../public/assets/brand/manifest-m-original.svg");
    expect(asset.trim()).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="61 78 109 78"><title>Manifest original geometry, tightly framed reference</title><g fill="#231f20"><polygon points="81.85 80.01 101.23 128.65 62.48 128.65"/><polygon points="115.34 154.36 95.97 105.73 134.72 105.73"/><polygon points="148.83 80.01 168.21 128.65 129.46 128.65"/></g></svg>');
    expect(declarations(".mark").mask).toContain('/assets/brand/manifest-m-original.svg');
    expect(declarations(".mark").background).toBe("#d6ff38");
    expect(declarations(".sealMark").background).toBe("#4056e8");
    expect(component).not.toContain("<polygon");
  });

  it.each(["lime", "teal", "blue"] as const)("supports an explicit %s mark without changing the name", (markTone) => {
    const html = renderToStaticMarkup(<PlatformBrandFooter markTone={markTone} />);
    expect(html).toContain(`data-tone="${markTone}"`);
    expect(html).toContain('aria-hidden="true">Manifest</span>');
  });

  it("uses the inherited actual Josefin 600 and white DM Sans tagline, independent of light tokens", () => {
    expect(declarations(".footer")).toMatchObject({ background: "#1a1a1a", color: "#ffffff", "--text": "#ffffff" });
    expect(declarations(".footer.footer .wordmark")).toMatchObject({
      "font-family": 'var(--font-platform-stat, "Josefin Sans", sans-serif)', "font-weight": "600", color: "#ffffff", "text-transform": "none"
    });
    expect(declarations(".footer.footer .tagline")).toMatchObject({
      "font-family": 'var(--font-platform-heading, "DM Sans", sans-serif)', color: "#ffffff"
    });
    expect(component).not.toMatch(/next\/font|<h[1-6]/);
    expect(css.toString()).not.toMatch(/gradient|background-clip/);
  });

  it("renders only real links, with decorative external arrows and truthful workspace wording", () => {
    const html = renderToStaticMarkup(<PlatformBrandFooter />);
    expect([...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]).filter((href) => !href.startsWith("#")))
      .toEqual(["https://manifestfts.com", "https://jongo.app", "/settings"]);
    expect(html.match(/aria-hidden="true">↗/g)).toHaveLength(2);
    expect(html).toContain('href="/settings">Workspace settings</a>');
  });

  it("gives multiple SSR seals unique sanitized IDs and valid local references", () => {
    const html = renderToStaticMarkup(<><PlatformBrandFooter /><PlatformBrandFooter /></>);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^manifest-seal-[a-zA-Z0-9_-]+$/));
    for (const reference of html.matchAll(/(?:href="#|aria-controls=")([^"]+)"/g)) expect(ids).toContain(reference[1]);
    expect(html.match(/>FORWARD THINKING SOLUTIONS<\/textPath>/g)).toHaveLength(2);
    expect(html).not.toContain("FORWARD THINKING SOLUTIONS.");
  });

  it("rotates only the ring once per 30s; center mark and ambient geometry stay static", () => {
    expect(declarations(".footer.footer .ring")).toMatchObject({ animation: "seal-turn 30s linear infinite", "transform-origin": "100px 100px", "animation-play-state": "running" });
    const animated: string[] = [];
    css.walkDecls("animation", (decl) => { if (decl.value !== "none") animated.push((decl.parent as postcss.Rule).selector); });
    expect(animated).toEqual([".footer.footer .ring"]);
    expect(component).not.toMatch(/requestAnimationFrame|setInterval|setTimeout|useEffect/);
    expect(component).toMatch(/className=\{styles\.ambient\}[^>]+aria-hidden="true" focusable="false"/);
    expect(declarations(".ambient")["pointer-events"]).toBe("none");
  });

  it("honors reduced motion and contains its responsive grid without viewport sizing", () => {
    const media: Record<string, string> = {};
    css.walkAtRules("media", (rule) => { media[rule.params] = rule.toString(); });
    expect(media["(prefers-reduced-motion: reduce)"]).toContain("animation: none");
    expect(media["(prefers-reduced-motion: reduce)"]).toContain("display: none");
    expect(declarations(".footer")).toMatchObject({ width: "100%", "max-width": "100%", "min-width": "0" });
    expect(declarations(".content")["grid-template-columns"]).toBe("minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr)");
    expect(media["(max-width: 64rem)"]).toContain("repeat(2, minmax(0, 1fr))");
    expect(media["(max-width: 32rem)"]).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css.toString()).not.toContain("100vw");
  });
});

describe("seal pause control", () => {
  it("toggles real hook state, aria-pressed and CSS animation-play-state without changing its accessible name", () => {
    hooks.active = true;
    const render = () => {
      const tree = PlatformBrandFooter({});
      const button = elements(tree).find((element) => element.type === "button")!;
      return { tree, button };
    };
    let view = render();
    expect(view.button.props.type).toBe("button");
    expect(view.button.props["aria-pressed"]).toBe(false);
    expect(view.button.props.children).toBe("Pause seal animation");
    expect(view.button.props["aria-controls"]).toBe("manifest-seal-testfooter");
    view.button.props.onClick();
    view = render();
    expect(view.button.props["aria-pressed"]).toBe(true);
    expect(view.tree.props["data-motion-paused"]).toBe(true);
    expect(declarations('.footer[data-motion-paused="true"] .ring')["animation-play-state"]).toBe("paused");
    view.button.props.onClick();
    view = render();
    expect(view.button.props["aria-pressed"]).toBe(false);
    expect(view.tree.props["data-motion-paused"]).toBe(false);
    expect(view.button.props.children).toBe("Pause seal animation");
  });
});