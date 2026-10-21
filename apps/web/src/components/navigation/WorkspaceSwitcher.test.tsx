import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  active: false, cursor: 0, slots: [] as any[], effects: [] as (() => void)[],
  pathname: "/dashboard", push: vi.fn(), refresh: vi.fn()
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: <T,>(initial: T) => {
      if (!h.active) return actual.useState(initial);
      const slot = h.cursor++;
      if (!(slot in h.slots)) h.slots[slot] = initial;
      return [h.slots[slot], (value: T | ((previous: T) => T)) => {
        h.slots[slot] = typeof value === "function" ? (value as (previous: T) => T)(h.slots[slot]) : value;
      }];
    },
    useRef: <T,>(initial: T) => {
      if (!h.active) return actual.useRef(initial);
      const slot = h.cursor++;
      if (!(slot in h.slots)) h.slots[slot] = { current: initial };
      return h.slots[slot];
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
      if (!h.active) return actual.useEffect(effect, deps);
      const slot = h.cursor++;
      const previous = h.slots[slot];
      if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
        h.effects.push(() => {
          previous?.cleanup?.();
          h.slots[slot] = { deps, cleanup: effect() };
        });
      }
    },
    useId: () => h.active ? "switcher-test" : actual.useId()
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("next/link", () => ({ default: (props: any) => React.createElement("a", props) }));
import WorkspaceSwitcher, { workspaceForPath, type WorkspaceSwitcherProps } from "./WorkspaceSwitcher";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";

const acme = { id: "org-acme", name: "Acme", slug: "acme", planLabel: "Studio" as const };
const beta = { id: "org-beta", name: "Beta", slug: "beta", planLabel: null };
const defaults: WorkspaceSwitcherProps = { initialOptions: [acme, beta], hasMore: true, nextCursor: "initial-cursor" };
const response = (items = [acme], hasMore = false, nextCursor: string | null = null) =>
  ({ ok: true, json: async () => ({ items, hasMore, nextCursor }) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  return React.Children.toArray(node).flatMap((child) => React.isValidElement<any>(child)
    ? [child, ...elements(child.props.children)] : []);
}
class FakeNode {}
let modal: boolean;
let rootNode: FakeNode & { ownerDocument: any; contains: (target: unknown) => boolean; querySelector: () => unknown };
let listeners: Map<string, EventListener>;
let triggerFocus: ReturnType<typeof vi.fn>;
let searchFocus: ReturnType<typeof vi.fn>;
function render(props = defaults) {
  h.cursor = 0;
  const tree = WorkspaceSwitcher(props);
  const all = elements(tree);
  const trigger = all.find((node) => node.type === "button" && "aria-expanded" in node.props)!;
  const input = all.find((node) => node.type === "input")!;
  const panel = all.find((node) => node.type === "section")!;
  (tree as any).ref.current = rootNode;
  (trigger as any).ref.current = { focus: triggerFocus };
  (input as any).ref.current = { focus: searchFocus };
  h.effects.splice(0).forEach((effect) => effect());
  return { tree, all, trigger, input, panel, create: all.find((node) => node.type === CreateOrganizationForm)! };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function open() {
  render().trigger.props.onClick();
  return render();
}
function search(value: string) { render().input.props.onChange({ target: { value } }); }
const key = (value: string) => ({ key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() });

beforeEach(() => {
  vi.stubGlobal("React", React);
  h.active = false;
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.pathname = "/dashboard";
  h.push.mockClear();
  h.refresh.mockClear();
  modal = false;
  listeners = new Map();
  triggerFocus = vi.fn();
  searchFocus = vi.fn();
  rootNode = Object.assign(new FakeNode(), {
    ownerDocument: {
      addEventListener: (name: string, fn: EventListener) => listeners.set(name, fn),
      removeEventListener: (name: string, fn: EventListener) => { if (listeners.get(name) === fn) listeners.delete(name); }
    },
    contains: (target: unknown) => target === rootNode,
    querySelector: () => modal ? {} : null
  });
});
afterEach(() => {
  h.slots.forEach((slot) => slot?.cleanup?.());
  h.active = false;
  vi.unstubAllGlobals();
});

describe("route identity and static accessible disclosure", () => {
  it.each(["/dashboard", "/clients", "/clients/unknown", "/clients/acme-else", "/sites/org-acme", "/clients/%E0%A4%A"])("never picks a fake first workspace for %s", (path) => {
    expect(workspaceForPath(path, [acme, beta])).toBeNull();
  });
  it.each(["/clients/org-acme", "/clients/acme", "/clients/acme/content/x", "/clients/%61cme"])("recognizes ID/slug route %s", (path) => {
    expect(workspaceForPath(path, [acme, beta])).toEqual(acme);
  });
  it("renders native button, hidden named region, labeled bounded search and ordinary links, not a menu", () => {
    const html = renderToStaticMarkup(<WorkspaceSwitcher {...defaults} />);
    expect(html).toContain("All workspaces");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<section[^>]*aria-label="Switch workspace"[^>]*hidden=""/);
    expect(html).toContain('type="search"');
    expect(html).toContain('maxLength="100"');
    expect(html).toContain('href="/clients/org-acme"');
    expect(html).not.toMatch(/role="(?:menu|menuitem|listbox|option)"|aria-haspopup="menu"/);
    expect(html).toContain("+ Create Team / Workspace");
    expect(html).toContain("<dialog");
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    for (const match of html.matchAll(/(?:for|aria-controls|aria-labelledby)="([^"]+)"/g)) expect(ids).toContain(match[1]);
  });
  it("displays the active org and truthful badge, supports active option outside initial page", () => {
    h.pathname = "/clients/acme/content";
    const html = renderToStaticMarkup(<WorkspaceSwitcher {...defaults} />);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*?Acme.*?Studio/s);
    expect(html).toMatch(/href="\/clients\/org-acme"[^>]*aria-current="page"/);
    h.pathname = "/clients/beta";
    const other = renderToStaticMarkup(<WorkspaceSwitcher initialOptions={[]} activeWorkspace={beta} />);
    expect(other).toContain("Beta");
    expect(other).not.toMatch(/Studio|Scale|Starter|Pro/);
  });
  it("has collision-free controls/labels for multiple instances", () => {
    const html = renderToStaticMarkup(<><WorkspaceSwitcher {...defaults} /><WorkspaceSwitcher {...defaults} /></>);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("real handlers with isolated hook state (no live API/DOM)", () => {
  beforeEach(() => {
    h.active = true;
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
  });
  it("opens, focuses search, refreshes from authenticated no-store endpoint, and closes with Escape/refocus", async () => {
    open();
    expect(searchFocus).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/workspaces?search=&limit=100", {
      credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal)
    });
    await tick();
    expect(render().panel.props.hidden).toBe(false);
    const event = key("Escape");
    render().tree.props.onKeyDown!(event as any);
    expect(render().trigger.props["aria-expanded"]).toBe(false);
    expect(triggerFocus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
  it.each(["pointerdown", "focusin"])("closes on outside %s without stealing focus, but not inside", (kind) => {
    open();
    listeners.get(kind)!({ target: rootNode } as unknown as Event);
    expect(render().panel.props.hidden).toBe(false);
    listeners.get(kind)!({ target: new FakeNode() } as unknown as Event);
    expect(render().panel.props.hidden).toBe(true);
    expect(triggerFocus).not.toHaveBeenCalled();
  });
  it("retains the mounted create form and visible ancestor through native dialog focus/Escape/outside lifecycle", () => {
    open();
    modal = true;
    listeners.get("focusin")!({ target: new FakeNode() } as unknown as Event);
    listeners.get("pointerdown")!({ target: new FakeNode() } as unknown as Event);
    const event = key("Escape");
    render().tree.props.onKeyDown!(event as any);
    render().trigger.props.onClick();
    expect(render().panel.props.hidden).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    modal = false; // Native drawer canceled; its trigger is still visible.
    render().trigger.props.onClick();
    expect(render().panel.props.hidden).toBe(true);
    expect(render().create.type).toBe(CreateOrganizationForm);
  });
  it("reuses creation callback, closes disclosure and navigates to real client route", () => {
    open();
    const form = render().create;
    expect(form.props.triggerLabel).toBe("+ Create Team / Workspace");
    form.props.onCreated({ id: "new-org", name: "New org" });
    expect(h.push).toHaveBeenCalledWith("/clients/new-org");
    expect(render().panel.props.hidden).toBe(true);
    expect(render().create.type).toBe(CreateOrganizationForm);
  });
  it.each(["fetch", "json"])("aborts superseded %s and ignores stale results", async (phase) => {
    const old = deferred<any>();
    const newer = deferred<any>();
    const mock = vi.fn().mockImplementationOnce(() => phase === "fetch" ? old.promise : Promise.resolve({ ok: true, json: () => old.promise }))
      .mockImplementationOnce(() => newer.promise);
    vi.stubGlobal("fetch", mock);
    open();
    await tick();
    search("Beta");
    expect(mock.mock.calls[0][1].signal.aborted).toBe(true);
    old.resolve(phase === "fetch" ? response() : await response().json());
    await tick();
    expect(render().all.find((node) => node.props["aria-busy"] === true)).toBeTruthy();
    newer.resolve({ ok: true, json: async () => ({ items: [beta], hasMore: false, nextCursor: null }) });
    await tick();
    const links = render().all.filter((node) => node.props.href);
    expect(links.map((node) => node.props.href)).toEqual(["/clients", "/clients/org-beta"]);
  });
  it("searches remotely, consumes server next cursor, appends without duplicates, and preserves ordinary selection links", async () => {
    const mock = vi.fn().mockResolvedValueOnce(response([acme], true, "next-page"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [acme, beta], hasMore: false, nextCursor: null }) });
    vi.stubGlobal("fetch", mock);
    open();
    await tick();
    const more = render().all.find((node) => node.type === "button" && node.props.children === "Load more workspaces")!;
    more.props.onClick();
    expect(mock.mock.calls[1][0]).toBe("/api/workspaces?search=&limit=100&cursor=next-page");
    await tick();
    const view = render();
    expect(view.all.filter((node) => node.props.href).map((node) => node.props.href)).toEqual(["/clients", "/clients/org-acme", "/clients/org-beta"]);
    view.all.find((node) => node.props.href === "/clients/org-beta")!.props.onClick();
    expect(render().panel.props.hidden).toBe(true);
    expect(h.push).not.toHaveBeenCalled(); // Link owns normal navigation; no global filter side effect.
  });
  it("bounds search, clears old matches and retries remote failures", async () => {
    open();
    await tick();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    search("x".repeat(101));
    await tick();
    expect(render().input.props.value).toHaveLength(100);
    expect(render().all.find((node) => node.props.role === "alert")).toBeTruthy();
    const retry = render().all.find((node) => node.type === "button" && node.props.children === "Retry")!;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([])));
    retry.props.onClick();
    await tick();
    expect(render().all.find((node) => node.props.role === "alert")).toBeUndefined();
    expect(render().all.find((node) => node.props.children === "No workspaces found.")).toBeTruthy();
  });
  it.each([
    { items: [acme], hasMore: true, nextCursor: null },
    { items: [{ ...acme, planLabel: "Unknown" }], hasMore: false, nextCursor: null },
    { items: Array.from({ length: 101 }, () => acme), hasMore: false, nextCursor: null },
    { organizations: [acme] }
  ])("rejects malformed or unbounded server responses", async (data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
    open();
    await tick();
    expect(render().all.find((node) => node.props.role === "alert")).toBeTruthy();
    expect(render().all.filter((node) => node.props.href).map((node) => node.props.href)).toEqual(["/clients"]);
  });
  it("does not apply a response from a closed disclosure after reopening", async () => {
    const old = deferred<any>();
    const newer = deferred<any>();
    const mock = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => newer.promise);
    vi.stubGlobal("fetch", mock);
    open();
    render().trigger.props.onClick();
    open();
    old.resolve(response());
    await tick();
    expect(render().all.find((node) => node.props["aria-busy"] === true)).toBeTruthy();
    newer.resolve({ ok: true, json: async () => ({ items: [beta], hasMore: false, nextCursor: null }) });
    await tick();
    expect(render().all.filter((node) => node.props.href).map((node) => node.props.href)).toEqual(["/clients", "/clients/org-beta"]);
  });
  it("retains search when loading the next remote result page", async () => {
    const mock = vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([acme], true, "search-cursor"))
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", mock);
    open();
    await tick();
    search("Acme");
    await tick();
    render().all.find((node) => node.props.children === "Load more workspaces")!.props.onClick();
    expect(mock.mock.calls[2][0]).toBe("/api/workspaces?search=Acme&limit=100&cursor=search-cursor");
    await tick();
  });
  it.each(["close", "navigation", "unmount"])("aborts pending work on %s, including late rejection", async (action) => {
    const pending = deferred<any>();
    const mock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", mock);
    open();
    if (action === "close") render().trigger.props.onClick();
    if (action === "navigation") { h.pathname = "/clients/acme"; render(); }
    if (action === "unmount") h.slots.forEach((slot) => slot?.cleanup?.());
    expect((mock.mock.calls[0] as any)[1].signal.aborted).toBe(true);
    pending.reject(new Error("late"));
    await tick();
    expect(render().all.find((node) => node.props.role === "alert")).toBeUndefined();
  });
});

describe("responsive scoped CSS contract", () => {
  it("keeps controls reachable, native hidden semantics, bounded scrolling, focus and forced-colors support", () => {
    const css = readFileSync(new URL("./WorkspaceSwitcher.module.css", import.meta.url), "utf8");
    expect(() => postcss.parse(css)).not.toThrow();
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("calc(100vw - 2rem)");
    expect(css).toContain("max-width: 100%");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/\.panel\[hidden\]\s*\{\s*display: none/);
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("40dvh");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("#8096ff");
    expect(css).toContain("forced-colors: active");
    expect(css).not.toMatch(/transition:|animation:|body\s*\{|html\s*\{/);
  });
});