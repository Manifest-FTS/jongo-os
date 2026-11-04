import { describe, expect, it, vi } from "vitest";
import { progressResponse, reportStep, wantsProgress } from "./progress";
import { applyStep, postWithProgress } from "../components/CreationProgress";

async function lines(response: Response) {
  const text = await response.text();
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

describe("streamed progress", () => {
  it("streams each reported step, then the normal response", async () => {
    const response = progressResponse(async () => {
      reportStep("hosting", "Preparing", "active");
      await new Promise((resolve) => setTimeout(resolve, 5));
      reportStep("hosting", "Preparing", "done");
      reportStep("create", "Creating", "failed", "HTTP 422");
      return Response.json({ ok: false, error: "nope" }, { status: 502 });
    });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await lines(response)).toEqual([
      { type: "started" },
      { type: "step", id: "hosting", label: "Preparing", status: "active" },
      { type: "step", id: "hosting", label: "Preparing", status: "done" },
      { type: "step", id: "create", label: "Creating", status: "failed", detail: "HTTP 422" },
      { type: "result", status: 502, body: { ok: false, error: "nope" } }
    ]);
  });

  it("does nothing outside a streamed request", () => {
    expect(() => reportStep("x", "y", "active")).not.toThrow();
    expect(wantsProgress(new Request("http://x", { headers: { accept: "application/json" } }))).toBe(false);
    expect(wantsProgress(new Request("http://x", { headers: { accept: "application/x-ndjson" } }))).toBe(true);
  });

  it("keeps working when the browser leaves halfway", async () => {
    let finished = false;
    const response = progressResponse(async () => {
      reportStep("a", "A", "active");
      await new Promise((resolve) => setTimeout(resolve, 20));
      reportStep("a", "A", "done");
      finished = true;
      return Response.json({ ok: true });
    });
    await response.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(finished).toBe(true);
  });

  it("turns a thrown error into a result instead of a broken stream", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = progressResponse(async () => {
      throw new Error("boom");
    });
    const all = await lines(response);
    spy.mockRestore();
    expect(all.at(-1)).toMatchObject({ type: "result", status: 500, body: { ok: false } });
  });
});

describe("postWithProgress (browser side)", () => {
  it("reads steps as they arrive and returns the final result", async () => {
    const steps: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () =>
      progressResponse(async () => {
        reportStep("create", "Creating", "active");
        reportStep("create", "Creating", "done");
        return Response.json({ ok: true, siteId: "s1" }, { status: 201 });
      })
    ));
    const out = await postWithProgress("/x", {}, (step) => steps.push(`${step.id}:${step.status}`));
    vi.unstubAllGlobals();
    expect(steps).toEqual(["create:active", "create:done"]);
    expect(out).toEqual({ status: 201, body: { ok: true, siteId: "s1" } });
  });

  it("still works when the server answers with plain JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Only admins" }, { status: 403 })));
    const out = await postWithProgress("/x", {}, () => undefined);
    vi.unstubAllGlobals();
    expect(out).toEqual({ status: 403, body: { error: "Only admins" } });
  });

  it("updates a listed step in place and adds unknown ones at the end", () => {
    const start = [{ id: "a", label: "A", status: "pending" as const }];
    expect(applyStep(start, { id: "a", label: "A real", status: "active" })).toEqual([{ id: "a", label: "A real", status: "active" }]);
    expect(applyStep(start, { id: "b", label: "B", status: "done" })).toHaveLength(2);
  });
});
