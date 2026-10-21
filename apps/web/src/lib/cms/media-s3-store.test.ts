import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createS3CompatibleCmsMediaStore, purgeCloudflareMedia, readCloudflarePurgeConfig, readS3MediaConfig } from "./media-s3-store";

const dataset = "11111111-1111-4111-8111-111111111111";
const media = "22222222-2222-4222-8222-222222222222";
const bytes = Buffer.from("synthetic webp fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
const key = `${dataset}/${media}/${hash}.webp`;
const env = {
  CMS_MEDIA_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com", CMS_MEDIA_S3_REGION: "us-west-004",
  CMS_MEDIA_S3_PRIVATE_BUCKET: "jongo-private-media", CMS_MEDIA_S3_PUBLIC_BUCKET: "jongo-public-media",
  CMS_MEDIA_S3_ACCESS_KEY_ID: "syntheticAccessKey123",
  CMS_MEDIA_S3_SECRET_ACCESS_KEY: "synthetic-secret-key-value-123456789", CMS_MEDIA_CDN_ORIGIN: "https://media.example",
  CLOUDFLARE_ZONE_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token-123456"
};

const response = (status: number, body: BodyInit | null = null, headers?: HeadersInit) => new Response(body, { status, headers });

describe("production S3-compatible media adapter", () => {
  it("validates all required server configuration and refuses origin/key ambiguity", () => {
    expect(readS3MediaConfig(env)).toMatchObject({ endpoint: env.CMS_MEDIA_S3_ENDPOINT, cdnOrigin: env.CMS_MEDIA_CDN_ORIGIN });
    expect(() => readS3MediaConfig({ ...env, CMS_MEDIA_CDN_ORIGIN: "http://media.example" })).toThrow();
    expect(() => readS3MediaConfig({ ...env, CMS_MEDIA_S3_ENDPOINT: "https://user:pass@example.com" })).toThrow();
    expect(() => readS3MediaConfig({ ...env, CMS_MEDIA_S3_PUBLIC_BUCKET: "../bucket" })).toThrow();
    expect(() => readS3MediaConfig({ ...env, CMS_MEDIA_S3_ACCESS_KEY_ID: "" })).toThrow();
    expect(() => readS3MediaConfig({ ...env, CMS_MEDIA_S3_SECRET_ACCESS_KEY: "secret" })).toThrow();
    const store = createS3CompatibleCmsMediaStore(readS3MediaConfig(env), vi.fn() as unknown as typeof fetch);
    expect(() => store.publicUrl("../escape")).toThrow();
  });

  it("signs create-only private put, server-authenticated bounded get, and public copy with immutable cache headers", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ url, init: init! });
      if (init?.method === "GET" && url.pathname.startsWith("/jongo-private-media/")) return response(200, bytes, { "content-length": String(bytes.length) });
      if (init?.method === "GET") return response(404);
      if (init?.method === "PUT" && new Headers(init.headers).has("x-amz-copy-source")) return response(200, "<CopyObjectResult/>");
      return response(200);
    }) as unknown as typeof fetch;
    const store = createS3CompatibleCmsMediaStore(readS3MediaConfig(env), fetcher);
    await store.putPrivate(key, bytes);
    expect(await store.getPrivate(key)).toEqual(bytes);
    await store.promotePublic(key);
    expect(store.publicUrl(key)).toBe(`https://media.example/assets/${key}`);
    expect(calls[0].url.pathname).toBe(`/jongo-private-media/${key}`);
    expect(new Headers(calls[0].init.headers).get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=syntheticAccessKey123\//);
    expect(new Headers(calls[0].init.headers).get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    const copy = new Headers(calls[4].init.headers);
    expect(copy.get("cache-control")).toContain("immutable");
    expect(calls[4].url.pathname).toBe(`/jongo-public-media/${key}`);
    expect(copy.get("x-amz-copy-source")).toBe(`/jongo-private-media/${key}`);
  });

  it("removes every public/private version and marker, then verifies no versions remain", async () => {
    const calls: Array<{ url: URL; method: string }> = [];
    const deleted = new Set<string>();
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input)), method = init?.method ?? "GET"; calls.push({ url, method });
      if (method === "GET") {
        const prefix = url.searchParams.get("prefix")!;
        const version = url.pathname.startsWith("/jongo-private-media/") ? "private-v1" : "public-v1";
        const keyName = prefix;
        const versions = deleted.has(version) ? "" : `<Version><Key>${keyName}</Key><VersionId>${version}</VersionId></Version>`;
        return response(200, `<ListVersionsResult>${versions}<IsTruncated>false</IsTruncated></ListVersionsResult>`);
      }
      if (method === "DELETE") { deleted.add(url.searchParams.get("versionId")!); return response(204); }
      return response(200);
    }) as unknown as typeof fetch;
    const store = createS3CompatibleCmsMediaStore(readS3MediaConfig(env), fetcher);
    await store.deleteAllVersions(key);
    expect([...deleted].sort()).toEqual(["private-v1", "public-v1"]);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
    expect(calls.filter(call => call.method === "GET")).toHaveLength(4);
  });

  it("refuses malformed provider results and never follows redirects", async () => {
    const redirect = vi.fn(async () => response(301, null, { location: "https://evil.example" })) as unknown as typeof fetch;
    const store = createS3CompatibleCmsMediaStore(readS3MediaConfig(env), redirect);
    await expect(store.getPrivate(key)).rejects.toThrow();
    const wrongSize = vi.fn(async () => response(200, bytes, { "content-length": "999999999" })) as unknown as typeof fetch;
    await expect(createS3CompatibleCmsMediaStore(readS3MediaConfig(env), wrongSize).getPrivate(key)).rejects.toThrow();
  });
});

describe("Cloudflare exact-file purge", () => {
  it("requires explicit valid credentials and validates an exact asset URL before request", async () => {
    const config = readCloudflarePurgeConfig(env);
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) =>
      init?.method === "HEAD" ? response(404) : response(200, JSON.stringify({ success: true }))) as unknown as typeof fetch;
    const url = `https://media.example/assets/${key}`;
    await purgeCloudflareMedia(url, config, fetcher);
    await expect(purgeCloudflareMedia(url, config, fetcher, "https://other.example")).rejects.toThrow();
    expect(fetcher).toHaveBeenNthCalledWith(1, `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, expect.objectContaining({
      method: "POST", redirect: "manual", headers: expect.objectContaining({ authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }),
      body: JSON.stringify({ files: [url] })
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, url, expect.objectContaining({ method: "HEAD", headers: { "cache-control": "no-cache", pragma: "no-cache" } }));
    for (const bad of ["http://media.example/assets/x", `${url}?v=1`, url.replace("media.example", "evil.example"), "/assets/x"]) {
      await expect(purgeCloudflareMedia(bad, config, fetcher, "https://media.example")).rejects.toThrow();
    }
    await expect(purgeCloudflareMedia(url, config, vi.fn(async () => response(200, JSON.stringify({ success: false }))) as unknown as typeof fetch)).rejects.toThrow();
    const stale = vi.fn(async () => response(200, JSON.stringify({ success: true }))) as unknown as typeof fetch;
    await expect(purgeCloudflareMedia(url, config, stale)).rejects.toThrow(/still serves/);
    expect(() => readCloudflarePurgeConfig({ ...env, CLOUDFLARE_ZONE_ID: "invalid" })).toThrow();
  });
});
