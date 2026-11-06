import { describe, expect, it, vi } from "vitest";
import { parseSiteEvent, publishSiteEvent } from "./live-events";

vi.mock("pg", () => ({
  Client: class {
    on() { return this; }
    async connect() {}
    async query() {}
    async end() {}
  }
}));

describe("live events", () => {
  it("parses only well-formed events", () => {
    expect(parseSiteEvent('{"siteId":"s1","kind":"backup","at":"t"}')).toEqual({ siteId: "s1", kind: "backup", at: "t" });
    expect(parseSiteEvent('{"kind":"backup"}')).toBeNull();
    expect(parseSiteEvent("not json")).toBeNull();
    expect(parseSiteEvent(undefined)).toBeNull();
  });

  it("publishes the app id and kind only, and never throws", async () => {
    const db = { $executeRaw: vi.fn(async () => 1) };
    await publishSiteEvent("s1", "restore", { db });
    const payload = JSON.parse((db.$executeRaw.mock.calls[0] as unknown[])[2] as string);
    expect(Object.keys(payload).sort()).toEqual(["at", "kind", "siteId"]);
    expect(payload).toMatchObject({ siteId: "s1", kind: "restore" });

    const failing = { $executeRaw: vi.fn(async () => { throw new Error("db down"); }) };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(publishSiteEvent("s1", "backup", { db: failing })).resolves.toBeUndefined();
    spy.mockRestore();
    await publishSiteEvent(null, "backup", { db });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("delivers an event only to listeners of that app, and stops after unsubscribe", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u@127.0.0.1:1/db");
    const { subscribeToSite, __dispatchForTest } = await import("./live-events-listener");
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeToSite("site-a", a);
    subscribeToSite("site-b", b);
    __dispatchForTest('{"siteId":"site-a","kind":"operation","at":"t"}');
    expect(a).toHaveBeenCalledWith({ siteId: "site-a", kind: "operation", at: "t" });
    expect(b).not.toHaveBeenCalled();
    offA();
    __dispatchForTest('{"siteId":"site-a","kind":"operation","at":"t"}');
    expect(a).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
