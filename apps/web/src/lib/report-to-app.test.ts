import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs job helper, shared by the backup/restore scripts
import { appBaseCandidates, postToApp } from "../../../../scripts/report-to-app.mjs";

describe("appBaseCandidates", () => {
  it("tries the app on this container first, then the configured public addresses", () => {
    expect(appBaseCandidates({ PORT: "3000", APP_BASE_URL: "https://old.example.com/", NEXTAUTH_URL: "https://jongo.app" })).toEqual([
      "http://127.0.0.1:3000",
      "https://old.example.com",
      "https://jongo.app"
    ]);
  });
  it("defaults the port and drops duplicates and blanks", () => {
    expect(appBaseCandidates({ APP_BASE_URL: "", NEXTAUTH_URL: "http://127.0.0.1:3000" })).toEqual(["http://127.0.0.1:3000"]);
  });
});

describe("postToApp", () => {
  const env = { PORT: "3000", APP_BASE_URL: "https://old.example.com", BACKUP_RECONCILE_TOKEN: "tok" };

  it("falls through a 503 and a network error to the next address", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push(url);
      expect(init.headers.Authorization).toBe("Bearer tok");
      if (url.startsWith("http://127.0.0.1")) throw new Error("ECONNREFUSED");
      return { status: 503 } as Response;
    };
    const result = await postToApp("/api/ops/site-backup-record", { a: 1 }, { env: { ...env, NEXTAUTH_URL: "https://jongo.app" }, fetchImpl: async (u: string, i: any) => (u.startsWith("https://jongo.app") ? ({ status: 200 } as Response) : fetchImpl(u, i)) });
    expect(result).toEqual({ ok: true, status: 200, base: "https://jongo.app" });
    expect(calls).toEqual(["http://127.0.0.1:3000/api/ops/site-backup-record", "https://old.example.com/api/ops/site-backup-record"]);
  });

  it("stops at the first answer that isn't a server error (a 4xx is the app's real answer)", async () => {
    const calls: string[] = [];
    const result = await postToApp("/x", {}, { env, fetchImpl: async (url: string) => (calls.push(url), { status: 400 } as Response) });
    expect(result).toEqual({ ok: false, status: 400, base: "http://127.0.0.1:3000" });
    expect(calls).toHaveLength(1);
  });

  it("reports when no token is configured, without calling anything", async () => {
    const result = await postToApp("/x", {}, { env: { PORT: "3000" }, fetchImpl: async () => { throw new Error("should not call"); } });
    expect(result).toEqual({ ok: false, status: 0, base: null, error: "no ops token" });
  });
});
