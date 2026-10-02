/**
 * Cloudflare: authoritative DNS and SSL for domains Jongo registers.
 *
 * Each domain gets its own zone in the Jongo Cloudflare account; the domain's
 * nameservers at Namecheap are then pointed at the two Cloudflare assigns.
 * Universal SSL on every zone covers the apex and *.domain, which is the
 * "wildcard SSL" the plans promise, with no certificate to manage.
 *
 * Auth is a scoped API token (CLOUDFLARE_API_TOKEN), never the account-wide
 * Global API Key, plus CLOUDFLARE_ACCOUNT_ID for where new zones go.
 */

import { fullRecordName, type DnsRecordInput } from "@/lib/dns-record";

const API = "https://api.cloudflare.com/client/v4";

export function readCloudflareConfig(): { token: string; accountId: string } | null {
  const token = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  return token && accountId ? { token, accountId } : null;
}

export function isCloudflareConfigured(): boolean {
  return readCloudflareConfig() !== null;
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

type Envelope<T> = { success: boolean; result: T; errors?: Array<{ code: number; message: string }>; result_info?: { total_count?: number } };

async function cf<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<Envelope<T>> {
  const config = readCloudflareConfig();
  if (!config) throw new CloudflareError("Cloudflare is not configured.", null, 0);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store"
    });
    const envelope = (await response.json().catch(() => ({ success: false }))) as Envelope<T>;
    if (!response.ok || !envelope.success) {
      const first = envelope.errors?.[0];
      throw new CloudflareError(first?.message || `Cloudflare answered HTTP ${response.status}.`, first?.code ?? null, response.status);
    }
    return envelope;
  } catch (error) {
    if (error instanceof CloudflareError) throw error;
    throw new CloudflareError(error instanceof Error && error.name === "AbortError" ? "Cloudflare timed out." : "Could not reach Cloudflare.", null, 0);
  } finally {
    clearTimeout(timeout);
  }
}

export type CloudflareZone = { id: string; name: string; status: string; name_servers: string[] };

export async function verifyCloudflareToken(): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await cf<{ status: string }>("/user/tokens/verify");
    return { ok: result.result.status === "active", message: result.result.status };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Token check failed." };
  }
}

export async function findZone(name: string): Promise<CloudflareZone | null> {
  const config = readCloudflareConfig();
  const query = new URLSearchParams({ name, ...(config ? { "account.id": config.accountId } : {}) });
  const result = await cf<CloudflareZone[]>(`/zones?${query}`);
  return result.result[0] ?? null;
}

/** Creates the zone, or returns it if it already exists in this account. */
export async function ensureZone(name: string): Promise<CloudflareZone> {
  const existing = await findZone(name);
  if (existing) return existing;
  const config = readCloudflareConfig();
  const created = await cf<CloudflareZone>("/zones", {
    method: "POST",
    body: { name, account: { id: config?.accountId }, type: "full", jump_start: false }
  });
  return created.result;
}

export async function getZone(zoneId: string): Promise<CloudflareZone> {
  return (await cf<CloudflareZone>(`/zones/${encodeURIComponent(zoneId)}`)).result;
}

/**
 * The SSL defaults for a Jongo-hosted site: Full (Coolify serves its own
 * Let's Encrypt certificate at the origin) and HTTPS everywhere. "Full", not
 * "Full (strict)": the origin certificate is issued only after DNS points at
 * the server, and strict would fail the site until then.
 */
export async function applySslDefaults(zoneId: string): Promise<void> {
  const id = encodeURIComponent(zoneId);
  await cf(`/zones/${id}/settings/ssl`, { method: "PATCH", body: { value: "full" } });
  await cf(`/zones/${id}/settings/always_use_https`, { method: "PATCH", body: { value: "on" } });
}

export type CloudflareDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
};

export async function listDnsRecords(zoneId: string): Promise<CloudflareDnsRecord[]> {
  const result = await cf<CloudflareDnsRecord[]>(`/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=500`);
  return result.result;
}

function recordBody(record: DnsRecordInput, zoneName: string) {
  return {
    type: record.type,
    name: fullRecordName(record.name, zoneName),
    content: record.content,
    ttl: record.ttl,
    ...(["A", "AAAA", "CNAME"].includes(record.type) ? { proxied: record.proxied } : {}),
    ...(record.priority !== undefined ? { priority: record.priority } : {})
  };
}

export async function createDnsRecord(zoneId: string, zoneName: string, record: DnsRecordInput): Promise<CloudflareDnsRecord> {
  return (await cf<CloudflareDnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, { method: "POST", body: recordBody(record, zoneName) })).result;
}

export async function updateDnsRecord(zoneId: string, zoneName: string, recordId: string, record: DnsRecordInput): Promise<CloudflareDnsRecord> {
  return (
    await cf<CloudflareDnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, {
      method: "PUT",
      body: recordBody(record, zoneName)
    })
  ).result;
}

export async function deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
  await cf(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, { method: "DELETE" });
}
