import { createHash, createHmac } from "node:crypto";
import type { CmsMediaStore } from "./media";

if (typeof window !== "undefined") throw new Error("CMS media storage is server-only.");
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{64}\.webp$/;
const BUCKET = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;
const MAX_BYTES = 20 * 1024 * 1024;
class MissingObjectError extends Error {}
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new Error("CMS media provider response exceeded bounds.");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString("utf8");
}

export type S3MediaConfig = {
  endpoint: string; region: string; privateBucket: string; publicBucket: string; accessKeyId: string; secretAccessKey: string; cdnOrigin: string;
};
export type MediaFetch = typeof fetch;

export function readMediaCdnOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.CMS_MEDIA_CDN_ORIGIN ?? "";
  let origin: URL;
  try { origin = new URL(raw); } catch { throw new Error("CMS media CDN origin is missing or invalid."); }
  if (origin.protocol !== "https:" || origin.origin !== raw || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw new Error("CMS media CDN origin is missing or invalid.");
  return origin.origin;
}

export function readS3MediaConfig(env: Record<string, string | undefined> = process.env): S3MediaConfig {
  const config = {
    endpoint: env.CMS_MEDIA_S3_ENDPOINT ?? "", region: env.CMS_MEDIA_S3_REGION ?? "",
    privateBucket: env.CMS_MEDIA_S3_PRIVATE_BUCKET ?? "", publicBucket: env.CMS_MEDIA_S3_PUBLIC_BUCKET ?? "",
    accessKeyId: env.CMS_MEDIA_S3_ACCESS_KEY_ID ?? "", secretAccessKey: env.CMS_MEDIA_S3_SECRET_ACCESS_KEY ?? "",
    cdnOrigin: env.CMS_MEDIA_CDN_ORIGIN ?? ""
  };
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { throw new Error("CMS media storage configuration is invalid."); }
  const origin = new URL(readMediaCdnOrigin(env));
  if (endpoint.protocol !== "https:" || endpoint.origin !== config.endpoint || endpoint.username || endpoint.password ||
      endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
      origin.protocol !== "https:" || origin.origin !== config.cdnOrigin || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash ||
      !/^[a-z0-9-]{1,64}$/.test(config.region) || !BUCKET.test(config.privateBucket) || !BUCKET.test(config.publicBucket) ||
      config.privateBucket.includes("..") || config.publicBucket.includes("..") || config.privateBucket === config.publicBucket ||
      !/^[A-Za-z0-9]{3,128}$/.test(config.accessKeyId) ||
      config.secretAccessKey.length < 20 || config.secretAccessKey.length > 256 || /[\s\u0000-\u001f\u007f]/.test(config.secretAccessKey)) {
    throw new Error("CMS media storage configuration is invalid.");
  }
  return { ...config, endpoint: endpoint.origin, cdnOrigin: origin.origin };
}

function keyPath(key: string): string {
  if (typeof key !== "string" || !KEY.test(key)) throw new Error("Invalid CMS media object key.");
  return key.split("/").map(rfc3986).join("/");
}
function signedHeaders(url: URL, method: string, body: Buffer | string | null, extra: Record<string, string>, config: S3MediaConfig): Record<string, string> {
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = now.slice(0, 8);
  const payloadHash = body === null ? sha("") : sha(body);
  const headers = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": now, ...extra };
  const names = Object.keys(headers).map(name => name.toLowerCase()).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name as keyof typeof headers].trim().replace(/\s+/g, " ")}\n`).join("");
  const query = [...url.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [method, url.pathname, query, canonicalHeaders, names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), "s3"), "aws4_request");
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(signingKey, toSign).toString("hex")}` };
}

export function createS3CompatibleCmsMediaStore(config: S3MediaConfig, fetcher: MediaFetch = fetch): CmsMediaStore & { deleteAllVersions(key: string): Promise<void> } {
  const endpoint = new URL(config.endpoint);
  const objectUrl = (key: string, visibility: "private" | "public") => {
    const bucket = visibility === "private" ? config.privateBucket : config.publicBucket;
    return new URL(`/${rfc3986(bucket)}/${keyPath(key)}`, endpoint);
  };
  async function request(url: URL, method: string, body: Buffer | string | null = null, extra: Record<string, string> = {}): Promise<Response> {
    const contentHeaders: Record<string, string> = { ...extra };
    if (Buffer.isBuffer(body)) contentHeaders["content-length"] = String(body.length);
    const headers = signedHeaders(url, method, body, contentHeaders, config);
    let response: Response;
    try { response = await fetcher(url, { method, headers, body: body as BodyInit | null, redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error("CMS media provider request failed."); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new Error("CMS media provider refused a redirect."); }
    return response;
  }
  async function expectOk(response: Response, statuses: number[]) {
    await response.body?.cancel().catch(() => {});
    if (!statuses.includes(response.status)) throw new Error("CMS media provider operation failed.");
  }
  async function read(key: string, visibility: "private" | "public"): Promise<Buffer> {
    const response = await request(objectUrl(key, visibility), "GET");
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); throw new MissingObjectError("CMS media object unavailable."); }
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error("CMS media object read failed."); }
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BYTES) { await response.body.cancel(); throw new Error("CMS media object has invalid size."); }
    const chunks: Buffer[] = []; let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_BYTES) throw new Error("CMS media object exceeds size limit.");
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
    if (total !== length) throw new Error("CMS media object length mismatch.");
    return Buffer.concat(chunks, total);
  }
  async function versionsFor(key: string, visibility: "private" | "public", marker?: { key: string; versionId: string }): Promise<{ versions: string[]; next: { key: string; versionId: string } | null }> {
    const bucket = visibility === "private" ? config.privateBucket : config.publicBucket;
    const url = new URL(`/${rfc3986(bucket)}/`, endpoint);
    url.searchParams.set("versions", ""); url.searchParams.set("prefix", key);
    if (marker) { url.searchParams.set("key-marker", marker.key); url.searchParams.set("version-id-marker", marker.versionId); }
    const response = await request(url, "GET");
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("CMS media version listing failed."); }
    const xml = await boundedText(response, 1024 * 1024);
    const found: Array<{ key: string; versionId: string }> = [];
    for (const item of xml.matchAll(/<(?:Version|DeleteMarker)>([\s\S]*?)<\/(?:Version|DeleteMarker)>/g)) {
      const objectKey = item[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      const versionId = item[1].match(/<VersionId>([\s\S]*?)<\/VersionId>/)?.[1];
      if (objectKey === undefined || versionId === undefined) throw new Error("CMS media version listing was malformed.");
      const decodedKey = objectKey.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
      if (decodedKey === key) found.push({ key: decodedKey, versionId: versionId.replaceAll("&amp;", "&") });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!truncated) return { versions: found.map(item => item.versionId), next: null };
    const nextKey = xml.match(/<NextKeyMarker>([\s\S]*?)<\/NextKeyMarker>/)?.[1];
    const nextVersion = xml.match(/<NextVersionIdMarker>([\s\S]*?)<\/NextVersionIdMarker>/)?.[1];
    if (!nextKey || !nextVersion || found.length === 0) throw new Error("CMS media version pagination was malformed.");
    return { versions: found.map(item => item.versionId), next: { key: nextKey, versionId: nextVersion } };
  }
  async function deleteAllVersions(key: string): Promise<void> {
    for (const visibility of ["public", "private"] as const) {
      const target = keyPath(key);
      let marker: { key: string; versionId: string } | undefined;
      for (let page = 0; page < 100; page++) {
        const listed = await versionsFor(target, visibility, marker);
        for (const versionId of listed.versions) {
          const url = objectUrl(key, visibility);
          url.searchParams.set("versionId", versionId);
          await expectOk(await request(url, "DELETE"), [200, 204]);
        }
        if (!listed.next) break;
        if (page === 99) throw new Error("CMS media has too many retained versions.");
        marker = listed.next;
      }
      const verify = await versionsFor(target, visibility);
      if (verify.versions.length || verify.next) throw new Error("CMS media versions remain after deletion.");
    }
  }
  return {
    async putPrivate(key, bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BYTES || key.split("/")[2] !== `${sha(bytes)}.webp`) throw new Error("Invalid CMS media bytes.");
      const response = await request(objectUrl(key, "private"), "PUT", bytes, {
        "content-type": "image/webp", "if-none-match": "*"
      });
      await expectOk(response, [200]);
    },
    getPrivate: key => read(key, "private"),
    async promotePublic(key) {
      const original = await read(key, "private");
      try {
        const existing = await read(key, "public");
        if (!existing.equals(original) || key.split("/")[2] !== `${sha(existing)}.webp`) throw new Error("CMS public object conflict.");
        return;
      } catch (error) {
        if (!(error instanceof MissingObjectError)) throw error;
      }
      const source = `/${rfc3986(config.privateBucket)}/${keyPath(key)}`;
      const response = await request(objectUrl(key, "public"), "PUT", "", {
        "x-amz-copy-source": source, "content-type": "image/webp",
        "cache-control": "public, max-age=31536000, immutable", "x-amz-metadata-directive": "REPLACE"
      });
      await expectOk(response, [200]);
    },
    getPublic: key => read(key, "public"),
    publicUrl(key) { keyPath(key); return `${config.cdnOrigin}/assets/${key}`; },
    deleteAllVersions
  };
}

const CF_TOKEN = /^[A-Za-z0-9._-]{20,256}$/;
export type CloudflarePurgeConfig = { zoneId: string; apiToken: string };
export function readCloudflarePurgeConfig(env: Record<string, string | undefined> = process.env): CloudflarePurgeConfig {
  const zoneId = env.CLOUDFLARE_ZONE_ID ?? "", apiToken = env.CLOUDFLARE_API_TOKEN ?? "";
  if (!/^[a-f0-9]{32}$/.test(zoneId) || !CF_TOKEN.test(apiToken)) throw new Error("CMS CDN purge configuration is missing or invalid.");
  return { zoneId, apiToken };
}
export async function purgeCloudflareMedia(url: string, config: CloudflarePurgeConfig, fetcher: MediaFetch = fetch,
  expectedOrigin?: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("CMS CDN purge URL is invalid."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (expectedOrigin !== undefined && parsed.origin !== expectedOrigin) ||
      !/^https:\/\/[^/]+\/assets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.webp$/.test(url)) throw new Error("CMS CDN purge URL is invalid.");
  const controller = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetcher(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`, {
      method: "POST", redirect: "manual", signal: controller,
      headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ files: [url] })
    });
  } catch { throw new Error("CMS CDN purge request failed."); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("CMS CDN purge was not accepted."); }
  const text = await boundedText(response, 16_384);
  let data: { success?: unknown };
  try { data = JSON.parse(text) as { success?: unknown }; } catch { throw new Error("CMS CDN purge response was invalid."); }
  if (data.success !== true) throw new Error("CMS CDN purge was not accepted.");
  let verification: Response;
  try {
    verification = await fetcher(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "cache-control": "no-cache", pragma: "no-cache" } });
  } catch { throw new Error("CMS CDN purge could not be verified."); }
  await verification.body?.cancel().catch(() => {});
  if (verification.status !== 404 && verification.status !== 410) throw new Error("CMS CDN still serves the revoked media.");
}
