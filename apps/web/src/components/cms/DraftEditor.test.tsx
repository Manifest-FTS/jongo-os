import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ active: false, useRef: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useRef: (initial: unknown) => hooks.active ? hooks.useRef(initial) : actual.useRef(initial) };
});
import DraftEditor, { type DraftEditorProps } from "./DraftEditor";
import { cmsSchemaRegistry } from "@/lib/cms/schemas";
let slots: any[], cursor: number;
let props: DraftEditorProps;
const save = vi.fn();
const draw = () => { cursor = 0; return DraftEditor(props); };
const submit = (values = { company: "First" }) => draw().props.draft.onSave(values);
beforeEach(() => {
  slots = []; hooks.active = true;
  hooks.useRef.mockImplementation((initial) => {
    const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index];
  });
  save.mockReset();
  props = { schema: cmsSchemaRegistry.get("partnerStories")!, canEdit: true, initialDocument: {},
    documentId: null, nativeRev: null, documentUrl: "/clients/client/content/dataset", saveAction: save };
});
afterEach(() => { hooks.active = false; vi.unstubAllGlobals(); });
describe("persisted draft editor", () => {
  it("advances native CAS/document identity after creation, allowing successive saves", async () => {
    save.mockResolvedValueOnce({ status: "saved", documentId: "doc", nativeRev: "rev1" })
      .mockResolvedValueOnce({ status: "saved", documentId: "doc", nativeRev: "rev2" });
    expect((await submit()).message).toContain("Draft saved");
    await submit({ company: "Second" });
    expect(save.mock.calls[0][0]).toMatchObject({ documentId: null, expectedNativeRev: null });
    expect(save.mock.calls[1][0]).toMatchObject({ documentId: "doc", expectedNativeRev: "rev1" });
    expect(save.mock.calls[1][0].mutationId).not.toBe(save.mock.calls[0][0].mutationId);
    expect(draw().props.draft.initialDocument).toEqual({}); // no form remount/overwrite
  });
  it("reuses retry IDs only for the exact same request; changed input gets a new ID", async () => {
    save.mockResolvedValue({ status: "unavailable" });
    await submit(); await submit(); await submit({ company: "Changed" });
    expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);
    expect(save.mock.calls[2][0].mutationId).not.toBe(save.mock.calls[1][0].mutationId);
  });
  it("retains retry identity on a lost response", async () => {
    save.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ status: "saved", documentId: "doc", nativeRev: "rev" });
    await expect(submit()).rejects.toThrow("network"); await submit();
    expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);
  });
  it("retains form data after conflict and cannot overwrite with a refreshed token", async () => {
    props.documentId = "doc"; props.nativeRev = "stale";
    save.mockResolvedValue({ status: "conflict" });
    expect((await submit()).message).toContain("inputs are retained");
    expect((await submit({ company: "Keep my changes" })).message).toContain("Reload");
    expect(save).toHaveBeenCalledTimes(1);
    expect(slots[0].current.nativeRev).toBe("stale");
  });
  it("blocks concurrent submissions and does not fake persisted success", async () => {
    let resolve!: (value: any) => void;
    save.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const first = submit();
    expect((await submit()).message).toContain("already in progress");
    resolve({ status: "invalid", findings: [] });
    expect((await first).message).toContain("not saved"); expect(save).toHaveBeenCalledTimes(1);
    expect(slots[0].current.nativeRev).toBeNull();
  });
  it("disables saving without author access", async () => {
    props.canEdit = false;
    expect(draw().props.canAuthor).toBe(false); await submit(); expect(save).not.toHaveBeenCalled();
  });
});