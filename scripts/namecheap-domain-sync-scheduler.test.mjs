import { test } from "node:test";
import assert from "node:assert/strict";
import { DAILY_INTERVAL_MS, resolveSyncUrl, syncOnce } from "./namecheap-domain-sync-scheduler.mjs";

test("daily interval and local endpoint by default", () => {
  assert.equal(DAILY_INTERVAL_MS, 86_400_000);
  assert.equal(resolveSyncUrl({ PORT: "4321" }).href, "http://127.0.0.1:4321/api/ops/domains-sync-namecheap");
});

test("does not allow credentials, query tokens, insecure remote URLs or another endpoint", () => {
  for (const url of ["http://remote.example/api/ops/domains-sync-namecheap", "https://user:secret@example.com/api/ops/domains-sync-namecheap", "https://example.com/api/ops/domains-sync-namecheap?token=secret", "https://example.com/api/other"]) {
    assert.throws(() => resolveSyncUrl({ NAMECHEAP_SYNC_URL: url }));
  }
});

test("uses the dedicated bearer token, POST, no-store, and no redirects", async () => {
  let called = false;
  await syncOnce({ NAMECHEAP_SYNC_TOKEN: "dedicated-secret" }, async (url, options) => {
    called = true;
    assert.equal(url.search, "");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer dedicated-secret");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ ok: true, imported: 1 }), { status: 200 });
  });
  assert.equal(called, true);
});

test("does not fall back to other ops tokens", async () => {
  await assert.rejects(syncOnce({ OWNERSHIP_SYNC_TOKEN: "shared" }, async () => { assert.fail("must not fetch"); }), /NAMECHEAP_SYNC_TOKEN/);
});

test("never returns an upstream error message in diagnostics", async () => {
  await assert.rejects(syncOnce({ NAMECHEAP_SYNC_TOKEN: "dedicated-secret" }, async () => new Response(JSON.stringify({ error: "ApiKey=SECRET" }), { status: 503 })),
    (error) => error.message === "Namecheap sync failed (HTTP 503).");
});