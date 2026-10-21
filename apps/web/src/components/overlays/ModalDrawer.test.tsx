import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise lifecycle callbacks with minimal native-dialog doubles, not jsdom.
// Actual focus trapping, wheel scrolling and viewport reflow need a browser.
const hooks = vi.hoisted(() => ({
  cursor: 0, refs: [] as { current: unknown }[], dialog: null as unknown,
  effect: null as null | (() => void | (() => void)), dependencies: [] as unknown[]
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useId: () => "drawer-title",
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      return hooks.refs[index] ?? (hooks.refs[index] = { current: index === 0 ? hooks.dialog : initial });
    },
    useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
      hooks.effect = effect;
      hooks.dependencies = dependencies;
    }
  };
});
import ModalDrawer from "./ModalDrawer";

function style() {
  const values = new Map<string, string>();
  return {
    getPropertyValue: (key: string) => values.get(key) ?? "",
    getPropertyPriority: () => "",
    setProperty: (key: string, value: string) => values.set(key, value),
    removeProperty: (key: string) => values.delete(key)
  };
}
function fixture() {
  const trigger = { isConnected: true, focus: vi.fn() };
  const input = {};
  const body = { style: style() };
  const doc = {
    activeElement: trigger as unknown,
    documentElement: { style: style(), clientWidth: 1000 }, body,
    defaultView: { getComputedStyle: () => ({ paddingRight: "0px" }) }
  };
  const dialog = {
    open: false, ownerDocument: doc,
    showModal: vi.fn(() => { dialog.open = true; doc.activeElement = input; }),
    close: vi.fn(() => { dialog.open = false; doc.activeElement = body; }),
    contains: (node: unknown) => node === input,
    getBoundingClientRect: () => ({ left: 600, right: 1000, top: 0, bottom: 800 })
  };
  hooks.dialog = dialog;
  return { trigger, input, doc, dialog };
}
function render(open: boolean, onClose = vi.fn()) {
  hooks.cursor = 0;
  return ModalDrawer({ open, onClose, title: "Create client", children: <input /> });
}
function pointer(dialog: unknown, x: number, target = dialog) {
  return { currentTarget: dialog, target, clientX: x, clientY: 100 } as React.PointerEvent<HTMLDialogElement>;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  hooks.cursor = 0;
  hooks.refs = [];
  hooks.effect = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("native modal drawer lifecycle and dismissal", () => {
  it("opens with showModal, locks scrolling, then closes/unlocks/restores focus on cleanup", () => {
    const { dialog, doc, trigger } = fixture();
    render(true);
    const cleanup = hooks.effect!();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(doc.documentElement.style.getPropertyValue("scrollbar-gutter")).toBe("stable");
    expect(doc.body.style.getPropertyValue("overflow-y")).toBe("hidden");
    if (typeof cleanup === "function") cleanup();
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(doc.body.style.getPropertyValue("overflow-y")).toBe("");
    expect(doc.documentElement.style.getPropertyValue("scrollbar-gutter")).toBe("");
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it("does not open a closed drawer, nor steal focus that moved outside before disposal", () => {
    const { dialog, doc, trigger } = fixture();
    render(false);
    expect(hooks.effect!()).toBeUndefined();
    expect(dialog.showModal).not.toHaveBeenCalled();
    render(true);
    const cleanup = hooks.effect!();
    doc.activeElement = { other: true };
    if (typeof cleanup === "function") cleanup();
    expect(trigger.focus).not.toHaveBeenCalled();
  });
  it("does not focus a removed trigger", () => {
    const { trigger } = fixture();
    render(true);
    const cleanup = hooks.effect!();
    trigger.isConnected = false;
    if (typeof cleanup === "function") cleanup();
    expect(trigger.focus).not.toHaveBeenCalled();
  });
  it("survives StrictMode setup/cleanup/setup and ignores the old queued close", () => {
    const { dialog, doc } = fixture();
    const onClose = vi.fn();
    const tree = render(true, onClose);
    const cleanup = hooks.effect!();
    if (typeof cleanup === "function") cleanup();
    const secondCleanup = hooks.effect!();
    tree.props.onClose();
    expect(dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(doc.body.style.getPropertyValue("overflow-y")).toBe("hidden");
    if (typeof secondCleanup === "function") secondCleanup();
    expect(doc.body.style.getPropertyValue("overflow-y")).toBe("");
  });
  it("routes native cancel to the latest callback without premature close", () => {
    fixture();
    const first = vi.fn();
    render(true, first);
    const latest = vi.fn();
    const tree = render(true, latest);
    const preventDefault = vi.fn();
    tree.props.onCancel({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });
  it("handles bubbling Escape from a field with the latest callback, then cleans up on controlled close", () => {
    const { dialog, input, doc, trigger } = fixture();
    const first = vi.fn();
    render(true, first);
    const cleanup = hooks.effect!();
    const latest = vi.fn();
    const tree = render(true, latest);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    tree.props.onKeyDown({ key: "Escape", target: input,
      nativeEvent: { isComposing: false }, preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    // The handler requests a controlled close; it must not close natively first.
    expect(dialog.open).toBe(true);
    expect(dialog.close).not.toHaveBeenCalled();
    render(false, latest);
    if (typeof cleanup === "function") cleanup();
    expect(hooks.effect!()).toBeUndefined();
    expect(dialog.open).toBe(false);
    expect(doc.body.style.getPropertyValue("overflow-y")).toBe("");
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it.each([
    { key: "Escape", isComposing: true },
    { key: "Enter", isComposing: false },
    { key: "Tab", isComposing: false }
  ])("ignores $key when composing=$isComposing", ({ key, isComposing }) => {
    fixture();
    const onClose = vi.fn();
    const tree = render(true, onClose);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    tree.props.onKeyDown({ key, nativeEvent: { isComposing }, preventDefault, stopPropagation });
    expect(onClose).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
  it("dismisses a native externally closed dialog but ignores already-closed state", () => {
    const { dialog } = fixture();
    const onClose = vi.fn();
    const tree = render(true, onClose);
    dialog.open = false;
    tree.props.onClose();
    expect(onClose).toHaveBeenCalledOnce();
    render(false, onClose).props.onClose();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("requires both press and click outside; never dismisses inside or drag-out", () => {
    const { dialog, input } = fixture();
    const onClose = vi.fn();
    const tree = render(true, onClose);
    tree.props.onPointerDown(pointer(dialog, 750, input));
    tree.props.onClick(pointer(dialog, 200));
    expect(onClose).not.toHaveBeenCalled();
    tree.props.onPointerDown(pointer(dialog, 750));
    tree.props.onClick(pointer(dialog, 750));
    expect(onClose).not.toHaveBeenCalled();
    tree.props.onPointerDown(pointer(dialog, 200));
    tree.props.onClick(pointer(dialog, 200));
    expect(onClose).toHaveBeenCalledOnce();
    tree.props.onClick(pointer(dialog, 200));
    expect(onClose).toHaveBeenCalledOnce();
  });
});