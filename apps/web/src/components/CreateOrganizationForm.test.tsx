import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dependency-free handler harness: SSR uses the real hooks. Handler tests
// keep hook slots across renders without pretending to implement a browser.
const harness = vi.hoisted(() => ({ active: false, cursor: 0, slots: [] as unknown[], cleanups: [] as (() => void)[], refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: <T,>(initial: T) => {
      if (!harness.active) return actual.useState(initial);
      const slot = harness.cursor++;
      if (!(slot in harness.slots)) harness.slots[slot] = initial;
      return [harness.slots[slot], (value: T) => { harness.slots[slot] = value; }];
    },
    useRef: <T,>(initial: T) => {
      if (!harness.active) return actual.useRef(initial);
      const slot = harness.cursor++;
      if (!(slot in harness.slots)) harness.slots[slot] = { current: initial };
      return harness.slots[slot];
    },
    useEffect: (effect: () => void | (() => void)) => {
      if (!harness.active) return actual.useEffect(effect);
      const slot = harness.cursor++;
      if (!(slot in harness.slots)) {
        harness.slots[slot] = true;
        const cleanup = effect();
        if (cleanup) harness.cleanups.push(cleanup);
      }
    },
    useId: () => harness.active ? "test-form" : actual.useId()
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: harness.refresh }) }));
import CreateOrganizationForm, { createdOrganization, organizationInputError, ORGANIZATION_DESCRIPTION_LIMIT, ORGANIZATION_NAME_LIMIT } from "./CreateOrganizationForm";
import ModalDrawer, { lockDrawerScroll } from "./overlays/ModalDrawer";

type ElementProps = {
  children?: React.ReactNode; type?: string; name?: string; open?: boolean;
  onClick?: () => void; onClose?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
};
function elements(node: React.ReactNode): React.ReactElement<ElementProps>[] {
  return React.Children.toArray(node).flatMap((child) => React.isValidElement<ElementProps>(child)
    ? [child, ...elements(child.props.children)] : []);
}
function render(props: Parameters<typeof CreateOrganizationForm>[0] = {}) {
  harness.cursor = 0;
  const tree = CreateOrganizationForm(props);
  const all = elements(tree);
  return {
    all,
    trigger: all.find((item) => item.type === "button" && item.props.type === "button")!,
    drawer: all.find((item) => item.type === ModalDrawer)!,
    form: all.find((item) => item.type === "form")!,
    name: all.find((item) => item.props.name === "name")!,
    description: all.find((item) => item.props.name === "description")!
  };
}
function fill(name = "  Acme Corp  ", description = "  Client notes  ") {
  const view = render();
  view.trigger.props.onClick!();
  view.name.props.onChange!({ target: { value: name } });
  view.description.props.onChange!({ target: { value: description } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const submit = (view = render()) => view.form.props.onSubmit!({ preventDefault: vi.fn() });

beforeEach(() => {
  vi.stubGlobal("React", React);
  harness.active = false;
  harness.cursor = 0;
  harness.slots = [];
  harness.cleanups = [];
  harness.refresh.mockClear();
});
afterEach(() => {
  harness.cleanups.forEach((cleanup) => cleanup());
  harness.active = false;
  vi.unstubAllGlobals();
});

describe("organization drawer SSR and pure contracts", () => {
  it("preserves the native default trigger and allows the workspace label", () => {
    const html = renderToStaticMarkup(<CreateOrganizationForm />);
    expect(html).toContain("New Client");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('<dialog');
    expect(html).not.toMatch(/<dialog[^>]*\sopen(?:=|>)/);
    const custom = renderToStaticMarkup(<CreateOrganizationForm triggerLabel="+ Create Team / Workspace" />);
    expect(custom).toContain("+ Create Team / Workspace");
    expect(custom.match(/<svg/g) ?? []).toHaveLength(0);
  });
  it("pairs unique labels, help text and drawer IDs across instances", () => {
    const html = renderToStaticMarkup(<><CreateOrganizationForm /><CreateOrganizationForm /></>);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of html.matchAll(/(?:for|aria-describedby|aria-labelledby|aria-controls)="([^"]+)"/g)) expect(ids).toContain(match[1]);
    expect(html).toContain(`maxLength="${ORGANIZATION_NAME_LIMIT}"`);
    expect(html).toContain(`maxLength="${ORGANIZATION_DESCRIPTION_LIMIT}"`);
    expect(html).toContain('aria-label="Close drawer"');
  });
  it("accepts only the actual flat organization DTO and strips private fields", () => {
    expect(createdOrganization({ id: "org-id", name: "Acme", ownerId: "private" })).toEqual({ id: "org-id", name: "Acme" });
    for (const value of [null, {}, { organization: { id: "id", name: "Acme" } }, { id: 1, name: "Acme" }, { id: " ", name: "Acme" }, { id: "id", name: "" }]) expect(createdOrganization(value)).toBeNull();
  });
  it("enforces explicit client bounds, whitespace-required names and boundary values", () => {
    expect(organizationInputError(" \n ", "")).toContain("name");
    expect(organizationInputError("a".repeat(ORGANIZATION_NAME_LIMIT), "d".repeat(ORGANIZATION_DESCRIPTION_LIMIT))).toBeNull();
    expect(organizationInputError("a".repeat(ORGANIZATION_NAME_LIMIT + 1), "")).toContain("200");
    expect(organizationInputError("Acme", "d".repeat(ORGANIZATION_DESCRIPTION_LIMIT + 1))).toContain("2000");
  });
});

describe("real create request handlers (no DOM or live API)", () => {
  beforeEach(() => { harness.active = true; });
  it("posts trimmed input, validates flat DTO, refreshes and optionally notifies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "org-id", name: "Acme Corp", ownerId: "private" }) });
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    fill();
    await submit(render({ onCreated }));
    expect(fetchMock).toHaveBeenCalledWith("/api/organizations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme Corp", description: "Client notes" }), signal: expect.any(AbortSignal)
    });
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith({ id: "org-id", name: "Acme Corp" });
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(render().drawer.props.open).toBe(false);
  });
  it("omits blank descriptions and works with no callback", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "id", name: "Acme" }) });
    vi.stubGlobal("fetch", fetchMock);
    fill("Acme", "   ");
    await submit();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Acme" });
    expect(harness.refresh).toHaveBeenCalledOnce();
  });
  it("blocks invalid input before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fill("  ");
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<>{render().form}</>)).toContain('role="alert"');
  });
  it("blocks synchronous duplicate submits", async () => {
    const pending = deferred<unknown>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    fill();
    const view = render();
    const first = submit(view);
    await submit(view);
    expect(fetchMock).toHaveBeenCalledOnce();
    pending.resolve({ ok: true, json: async () => ({ id: "id", name: "Acme" }) });
    await first;
  });
  it.each(["fetch", "json"])("aborts cancel during %s and ignores late success after reopen", async (phase) => {
    const pending = deferred<unknown>();
    const newer = deferred<unknown>();
    const fetchMock = vi.fn().mockImplementationOnce(() => phase === "fetch" ? pending.promise : Promise.resolve({ ok: true, json: () => pending.promise }))
      .mockImplementationOnce(() => newer.promise);
    vi.stubGlobal("fetch", fetchMock);
    fill();
    const onCreated = vi.fn();
    const first = submit(render({ onCreated }));
    // Let fetch resolve so the JSON-phase case is actually awaiting json().
    await Promise.resolve();
    render().drawer.props.onClose!();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    fill("New workspace");
    const second = submit(render({ onCreated }));
    pending.resolve(phase === "fetch" ? { ok: true, json: async () => ({ id: "old", name: "Old" }) } : { id: "old", name: "Old" });
    await first;
    expect(render().drawer.props.open).toBe(true);
    expect(render().form.props).toMatchObject({ "aria-busy": true });
    expect(onCreated).not.toHaveBeenCalled();
    expect(harness.refresh).not.toHaveBeenCalled();
    newer.resolve({ ok: true, json: async () => ({ id: "new", name: "New workspace" }) });
    await second;
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith({ id: "new", name: "New workspace" });
  });
  it("aborts disposal and suppresses late errors", async () => {
    const pending = deferred<unknown>();
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    fill();
    const first = submit();
    harness.cleanups.forEach((cleanup) => cleanup());
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
    pending.reject(new Error("late"));
    await first;
    expect(harness.refresh).not.toHaveBeenCalled();
  });
  it.each([
    { ok: false, json: async () => ({ error: "Duplicate client" }), expected: "Duplicate client" },
    { ok: false, json: async () => { throw new Error("not JSON"); }, expected: "Failed to create organization" },
    { ok: true, json: async () => ({ organization: { id: "id", name: "Acme" } }), expected: "unexpected response" }
  ])("keeps failures open without callback/refresh: $expected", async ({ expected, ...response }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    fill();
    const onCreated = vi.fn();
    await submit(render({ onCreated }));
    expect(render().drawer.props.open).toBe(true);
    expect(renderToStaticMarkup(<>{render().form}</>)).toContain(expected);
    expect(onCreated).not.toHaveBeenCalled();
    expect(harness.refresh).not.toHaveBeenCalled();
  });
});

function fakeStyle(initial: Record<string, [string, string]> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getPropertyValue: (key: string) => values.get(key)?.[0] ?? "",
    getPropertyPriority: (key: string) => values.get(key)?.[1] ?? "",
    setProperty: (key: string, value: string, priority = "") => { values.set(key, [value, priority]); },
    removeProperty: (key: string) => { values.delete(key); }
  };
}
describe("reversible page lock and scoped CSS contracts", () => {
  it.each([true, false])("restores styles/priorities and compensates width only without stable-gutter support: %s", (stable) => {
    const rootStyle = fakeStyle({ "overflow-x": ["clip", ""], "overflow-y": ["auto", "important"], "scrollbar-gutter": ["auto", ""] });
    const bodyStyle = fakeStyle({ "padding-right": ["7px", "important"] });
    const doc = { documentElement: { style: rootStyle, get clientWidth() { return !stable && rootStyle.getPropertyValue("overflow-y") === "hidden" ? 1000 : 983; } }, body: { style: bodyStyle } } as unknown as Document;
    const view = { getComputedStyle: () => ({ paddingRight: "7px" }) } as unknown as Window;
    const release = lockDrawerScroll(doc, view);
    const releaseSecond = lockDrawerScroll(doc, view);
    expect(rootStyle.getPropertyValue("scrollbar-gutter")).toBe("stable");
    expect(bodyStyle.getPropertyValue("padding-right")).toBe(stable ? "7px" : "24px");
    release(); release();
    expect(rootStyle.getPropertyValue("overflow-y")).toBe("hidden");
    releaseSecond();
    expect(rootStyle.getPropertyValue("overflow-x")).toBe("clip");
    expect(rootStyle.getPropertyPriority("overflow-x")).toBe("");
    expect(rootStyle.getPropertyValue("overflow-y")).toBe("auto");
    expect(rootStyle.getPropertyPriority("overflow-y")).toBe("important");
    expect(rootStyle.getPropertyValue("scrollbar-gutter")).toBe("auto");
    expect(bodyStyle.getPropertyValue("overflow-x")).toBe("");
    expect(bodyStyle.getPropertyValue("overflow-y")).toBe("");
    expect(bodyStyle.getPropertyValue("padding-right")).toBe("7px");
    expect(bodyStyle.getPropertyPriority("padding-right")).toBe("important");
  });
  it("keeps light tokens, fixed header, one scroll region and browser-specific hidden local chrome", () => {
    const css = postcss.parse(readFileSync(fileURLToPath(new URL("./overlays/ModalDrawer.module.css", import.meta.url)), "utf8"));
    const declarations = (selector: string) => {
      const result: Record<string, string> = {};
      css.walkRules((rule) => { if (rule.selector === selector) rule.walkDecls((decl) => { result[decl.prop] = decl.value; }); });
      return result;
    };
    expect(declarations(".drawer")).toMatchObject({ "color-scheme": "light", "--surface": "#ffffff", "--text": "#1a1a1a", "--platform-error": "#b42318", position: "fixed", overflow: "hidden", width: "min(32rem, 100%)" });
    expect(declarations(".drawer::backdrop")).toMatchObject({ background: "rgb(0 0 0 / 50%)", "backdrop-filter": "blur(4px)" });
    expect(declarations(".header")).toMatchObject({ flex: "0 0 auto" });
    expect(declarations(".content")).toMatchObject({ "overflow-y": "auto", "scrollbar-width": "none", "min-height": "0" });
    expect(declarations(".content::-webkit-scrollbar")).toMatchObject({ display: "none" });
    expect(declarations(".primary, .secondary, .close")).toMatchObject({ "min-height": "44px", "min-width": "44px" });
    expect(declarations(".actions")).toMatchObject({ "flex-wrap": "wrap" });
    css.walkRules((rule) => expect(rule.selector).not.toMatch(/:global|\bhtml\b|\bbody\b/));
  });
});