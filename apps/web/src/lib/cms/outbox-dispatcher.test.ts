import { describe, expect, it, vi } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffMs, dispatchOutboxOnce, revalidationEventBody, signRevalidationEvent, targetSecret, targetUrl,
  type ClaimedEvent, type DeliveryResult, type FinishState, type OutboxStore, type PendingTarget,
} from "./outbox-dispatcher";

const vectorPath = fileURLToPath(new URL("./revalidation-signing-vector.json", import.meta.url));
const siblingVectorPath = fileURLToPath(new URL("../../../../../../../mfts-2026/tests/fixtures/revalidation-signing-vector.json", import.meta.url));
const vector = JSON.parse(readFileSync(vectorPath, "utf8"));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const datasetId = id(1);
const secret = "synthetic-dispatch-secret-0123456789abcdefghij";
const env = { CMS_OUTBOX_DISPATCH_ENABLED: "true", CMS_DELIVERY_SECRET_SITE: secret, CMS_DELIVERY_SECRET_OTHER: secret + "-other", NODE_ENV: "production" };
const T0 = new Date("2026-10-20T12:00:00.000Z");

type EventRow = ClaimedEvent & { status: "pending" | "processing" | "delivered" | "failed"; nextAttemptAt: Date; leaseUntil: Date | null; leaseToken: string | null };
type Target = PendingTarget & { enabled: boolean; datasetId: string };

/** In-memory mirror of the SQL store semantics (lease fencing, reclaim, monotonic receipts). */
function memoryStore(events: EventRow[], targets: Target[]) {
  const receipts = new Map<string, { status: "pending" | "delivered" | "dead"; attempts: number; error: string | null }>();
  const key = (e: string, t: string) => `${e}:${t}`;
  const store: OutboxStore = {
    async claim(now, leaseUntil, leaseToken, limit) {
      return events.filter(e => ((e.status === "pending" && e.nextAttemptAt <= now) || (e.status === "processing" && e.leaseUntil! < now)) &&
        targets.some(t => t.enabled && t.datasetId === e.datasetId)).slice(0, limit).map(e => {
        Object.assign(e, { status: "processing", leaseUntil, leaseToken, attempts: e.attempts + 1 });
        return { id: e.id, datasetId: e.datasetId, attempts: e.attempts };
      });
    },
    async pendingTargets(event) {
      return targets.filter(t => t.enabled && t.datasetId === event.datasetId && receipts.get(key(event.id, t.id))?.status !== "delivered");
    },
    async record(event, token, target, result: DeliveryResult) {
      const row = events.find(e => e.id === event.id)!;
      if (row.leaseToken !== token || row.status !== "processing") return false;
      const prior = receipts.get(key(event.id, target.id));
      if (prior && prior.status !== "pending") return false;
      receipts.set(key(event.id, target.id), { status: result.ok ? "delivered" : "pending", attempts: (prior?.attempts ?? 0) + 1, error: result.error });
      return true;
    },
    async finish(event, token, state: FinishState) {
      const row = events.find(e => e.id === event.id)!;
      if (row.leaseToken !== token || row.status !== "processing") return false;
      Object.assign(row, { status: state.status, leaseUntil: null, leaseToken: null, ...(state.status === "pending" ? { nextAttemptAt: state.nextAttemptAt } : {}) });
      if (state.status === "failed") for (const [k, r] of receipts) if (k.startsWith(event.id + ":") && r.status === "pending") r.status = "dead";
      return true;
    },
  };
  return { store, receipts, key };
}
const event = (n: number, o: Partial<EventRow> = {}): EventRow =>
  ({ id: id(100 + n), datasetId, attempts: 0, status: "pending", nextAttemptAt: T0, leaseUntil: null, leaseToken: null, ...o });
const target = (n: number, o: Partial<Target> = {}): Target =>
  ({ id: id(200 + n), datasetId, consumerId: `site-${n}`, url: `https://consumer${n}.example/api/content/revalidate`, secretEnv: "CMS_DELIVERY_SECRET_SITE", enabled: true, ...o });
function fetcher(statuses: number[] | ((url: string) => number)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const status = typeof statuses === "function" ? statuses(String(url)) : statuses.shift() ?? 200;
    return new Response(status === 204 ? null : "{}", { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

/** Same verification steps as mfts-2026 handleMarketingRevalidation. */
function receiverAccepts(init: RequestInit, key: string, expectedDataset: string, nowMs: number) {
  const headers = new Headers(init.headers);
  const timestamp = headers.get("x-jongo-timestamp") ?? "", signature = headers.get("x-jongo-signature") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(headers.get("content-type") ?? "") || headers.has("content-encoding")) return false;
  if (!/^\d{10}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(signature) || Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > 300) return false;
  const body = Buffer.from(String(init.body));
  if (body.byteLength > 16 * 1024) return false;
  const expected = createHmac("sha256", key).update(`v1.${timestamp}.`).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"))) return false;
  const record = JSON.parse(body.toString("utf8"));
  return Object.keys(record).sort().join(",") === "datasetId,eventId,version" && record.version === 1 &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(record.eventId) && record.datasetId === expectedDataset;
}

describe("signing", () => {
  it("matches the shared receiver vector", () => {
    expect(revalidationEventBody(vector.eventId, vector.datasetId)).toBe(vector.body);
    expect(signRevalidationEvent(vector.secret, vector.timestamp, vector.body)).toBe(vector.signature);
    expect(receiverAccepts({ body: vector.body, headers: { "content-type": "application/json", "x-jongo-timestamp": vector.timestamp,
      "x-jongo-signature": vector.signature } }, vector.secret, vector.datasetId, Number(vector.timestamp) * 1000)).toBe(true);
  });
  it.skipIf(!existsSync(siblingVectorPath))("vector is byte-identical to the mfts-2026 receiver copy", () => {
    expect(readFileSync(siblingVectorPath, "utf8")).toBe(readFileSync(vectorPath, "utf8"));
  });
  it("posts the exact receiver contract with an idempotent event ID", async () => {
    const rows = [event(1)], { store } = memoryStore(rows, [target(1)]), http = fetcher([200]);
    const summary = await dispatchOutboxOnce(store, { env, fetcher: http.fn, now: () => T0 });
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, retried: 0, deadLettered: 0, leaseLost: 0 });
    const { url, init } = http.calls[0];
    expect(url).toBe("https://consumer1.example/api/content/revalidate");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(JSON.stringify({ version: 1, eventId: rows[0].id, datasetId }));
    expect(new Headers(init.headers).get("x-jongo-timestamp")).toBe(String(T0.getTime() / 1000));
    expect(receiverAccepts(init, secret, datasetId, T0.getTime())).toBe(true);
    expect(receiverAccepts(init, secret + "x", datasetId, T0.getTime())).toBe(false);
    expect(rows[0].status).toBe("delivered");
  });
});

describe("backoff and dead-letter", () => {
  it("doubles from the base and caps", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([1, 2, 4, 8].map(n => n * BACKOFF_BASE_MS));
    expect(backoffMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(30)).toBe(BACKOFF_CAP_MS);
  });
  it("schedules retry only for the failed target and keeps per-target receipts", async () => {
    const rows = [event(1)], targets = [target(1), target(2, { secretEnv: "CMS_DELIVERY_SECRET_OTHER" })];
    const { store, receipts, key } = memoryStore(rows, targets);
    const first = fetcher(url => url.includes("consumer2") ? 500 : 200);
    expect(await dispatchOutboxOnce(store, { env, fetcher: first.fn, now: () => T0 })).toMatchObject({ retried: 1, delivered: 0 });
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 1, leaseToken: null, nextAttemptAt: new Date(T0.getTime() + BACKOFF_BASE_MS) });
    expect(receipts.get(key(rows[0].id, targets[0].id))?.status).toBe("delivered");
    expect(receipts.get(key(rows[0].id, targets[1].id))).toMatchObject({ status: "pending", error: "http_status" });
    expect((await dispatchOutboxOnce(store, { env, fetcher: first.fn, now: () => T0 })).claimed).toBe(0);
    const later = new Date(T0.getTime() + BACKOFF_BASE_MS), second = fetcher([200]);
    expect(await dispatchOutboxOnce(store, { env, fetcher: second.fn, now: () => later })).toMatchObject({ delivered: 1 });
    expect(second.calls.map(c => c.url)).toEqual([targets[1].url]);
    expect(rows[0].status).toBe("delivered");
  });
  it("dead-letters after the maximum attempts", async () => {
    const rows = [event(1)], { store, receipts, key } = memoryStore(rows, [target(1)]);
    let now = T0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const summary = await dispatchOutboxOnce(store, { env, fetcher: fetcher([503]).fn, now: () => now, maxAttempts: 3 });
      expect(summary).toMatchObject(attempt < 3 ? { retried: 1 } : { deadLettered: 1 });
      now = new Date(now.getTime() + backoffMs(attempt));
    }
    expect(rows[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(receipts.get(key(rows[0].id, id(201)))).toMatchObject({ status: "dead", attempts: 3 });
    expect((await dispatchOutboxOnce(store, { env, fetcher: fetcher([200]).fn, now: () => new Date(now.getTime() + BACKOFF_CAP_MS) })).claimed).toBe(0);
  });
  it("treats redirects, network errors and refused targets as failures without following", async () => {
    const rows = [event(1)];
    const targets = [target(1), target(2, { url: "http://consumer2.example/api/content/revalidate" }), target(3, { secretEnv: "CMS_DELIVERY_SECRET_MISSING" })];
    const { store, receipts, key } = memoryStore(rows, targets);
    const http = fetcher([302]);
    await dispatchOutboxOnce(store, { env, fetcher: http.fn, now: () => T0 });
    expect(http.calls).toHaveLength(1);
    expect(receipts.get(key(rows[0].id, targets[0].id))?.error).toBe("redirect");
    expect(receipts.get(key(rows[0].id, targets[1].id))?.error).toBe("target_refused");
    expect(receipts.get(key(rows[0].id, targets[2].id))?.error).toBe("secret_unavailable");
    const failing = memoryStore([event(2)], [target(1)]);
    const thrown = vi.fn(async () => { throw new Error("connect ECONNREFUSED private detail"); }) as unknown as typeof fetch;
    await dispatchOutboxOnce(failing.store, { env, fetcher: thrown, now: () => T0 });
    expect(failing.receipts.get(failing.key(id(102), id(201)))?.error).toBe("network");
  });
});

describe("lease", () => {
  it("does not double-claim live leases, reclaims expired ones and fences the stale worker", async () => {
    const rows = [event(1)], { store } = memoryStore(rows, [target(1)]);
    const crashed = await store.claim(T0, new Date(T0.getTime() + 60_000), id(900), 10);
    expect(crashed).toEqual([{ id: rows[0].id, datasetId, attempts: 1 }]);
    const http = fetcher([200]);
    expect((await dispatchOutboxOnce(store, { env, fetcher: http.fn, now: () => new Date(T0.getTime() + 59_000) })).claimed).toBe(0);
    expect(http.calls).toHaveLength(0);
    const summary = await dispatchOutboxOnce(store, { env, fetcher: http.fn, now: () => new Date(T0.getTime() + 61_000) });
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    expect(rows[0]).toMatchObject({ status: "delivered", attempts: 2 });
    expect(await store.finish(crashed[0], id(900), { status: "failed" }, T0)).toBe(false);
    expect(rows[0].status).toBe("delivered");
  });
  it("reports a lost lease instead of finishing", async () => {
    const rows = [event(1)], { store } = memoryStore(rows, [target(1)]);
    const stolen: OutboxStore = { ...store, record: async (...args) => { rows[0].leaseToken = id(901); return store.record(...args); } };
    expect(await dispatchOutboxOnce(stolen, { env, fetcher: fetcher([200]).fn, now: () => T0 })).toMatchObject({ claimed: 1, delivered: 0, leaseLost: 1 });
    expect(rows[0].leaseToken).toBe(id(901));
  });
});

describe("configuration and redaction", () => {
  it("is off unless explicitly enabled", async () => {
    const claim = vi.fn();
    for (const value of [undefined, "", "1", "TRUE", "yes"]) {
      const summary = await dispatchOutboxOnce({ claim } as unknown as OutboxStore, { env: { ...env, CMS_OUTBOX_DISPATCH_ENABLED: value } });
      expect(summary.enabled).toBe(false);
    }
    expect(claim).not.toHaveBeenCalled();
  });
  it("allows HTTPS, and plain HTTP only for explicit loopback in test", async () => {
    expect(targetUrl("https://site.example/api/content/revalidate", false)?.href).toBe("https://site.example/api/content/revalidate");
    for (const bad of ["http://site.example/x", "https://u:p@site.example/x", "https://site.example/x?y=1", "https://site.example/x#y", "ftp://site.example/", "not a url"]) {
      expect(targetUrl(bad, true)).toBeNull();
    }
    expect(targetUrl("http://127.0.0.1:4000/hook", false)).toBeNull();
    expect(targetUrl("http://127.0.0.1:4000/hook", true)?.port).toBe("4000");
    const rows = [event(1)], { store, receipts, key } = memoryStore(rows, [target(1, { url: "http://127.0.0.1:4000/hook" })]);
    const http = fetcher([200]);
    await dispatchOutboxOnce(store, { env, fetcher: http.fn, now: () => T0, allowLoopbackHttp: true });
    expect(http.calls).toHaveLength(0);
    expect(receipts.get(key(rows[0].id, id(201)))?.error).toBe("target_refused");
    rows[0].nextAttemptAt = T0;
    await dispatchOutboxOnce(store, { env: { ...env, NODE_ENV: "test" }, fetcher: http.fn, now: () => new Date(T0.getTime() + BACKOFF_BASE_MS), allowLoopbackHttp: true });
    expect(http.calls).toHaveLength(1);
  });
  it("reads only prefixed secret env names with receiver-compatible values", () => {
    expect(targetSecret("CMS_DELIVERY_SECRET_SITE", env)).toBe(secret);
    expect(targetSecret("DATABASE_URL", { DATABASE_URL: "x".repeat(40) })).toBeNull();
    expect(targetSecret("CMS_DELIVERY_SECRET_SHORT", { CMS_DELIVERY_SECRET_SHORT: "short" })).toBeNull();
    expect(targetSecret("CMS_DELIVERY_SECRET_SPACE", { CMS_DELIVERY_SECRET_SPACE: "has space ".repeat(5) })).toBeNull();
  });
  it("bounds the response read and never logs secrets, bodies or URLs", async () => {
    const lines: string[] = [];
    let pulled = 0, cancelled = false;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024).fill(65)); },
      cancel() { cancelled = true; },
    });
    const rows = [event(1)], { store } = memoryStore(rows, [target(1)]);
    const fn = vi.fn(async () => new Response(huge, { status: 500 })) as unknown as typeof fetch;
    await dispatchOutboxOnce(store, { env, fetcher: fn, now: () => T0, log: line => lines.push(line) });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    const output = lines.join("\n");
    expect(output).toContain(`event=${rows[0].id} consumer=site-1 failed=http_status status=500`);
    expect(output).not.toMatch(new RegExp([secret, "consumer1.example", "AAAA", '"version"'].join("|")));
  });
});
