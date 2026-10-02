/**
 * What a client may put in their DNS through Jongo. Pure.
 *
 * Checked here, with a message per field, rather than relying on Cloudflare's
 * error text: a rejected record should say what to fix in the form's words.
 */

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "CAA"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/** Cloudflare can proxy (orange cloud) only these. */
export const PROXIABLE_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];

export type DnsRecordInput = {
  type: DnsRecordType;
  /** "@" or a label like "www"; expanded to the full name for Cloudflare. */
  name: string;
  content: string;
  /** Seconds; 1 means "automatic". */
  ttl: number;
  proxied: boolean;
  priority?: number;
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9_])?)*\.?$/i;
const LABEL = /^(\*|@|[a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9_])?)*$/i;

/** "@" -> the zone; "www" -> www.zone; already-full names are kept. */
export function fullRecordName(name: string, zone: string): string {
  const value = name.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value === "@" || value === zone) return zone;
  if (value.endsWith(`.${zone}`)) return value;
  return `${value}.${zone}`;
}

/** The inverse, for display: zone -> "@", www.zone -> "www". */
export function shortRecordName(name: string, zone: string): string {
  const value = name.toLowerCase();
  if (value === zone) return "@";
  return value.endsWith(`.${zone}`) ? value.slice(0, -(zone.length + 1)) : value;
}

export type DnsValidation =
  | { ok: true; record: DnsRecordInput }
  | { ok: false; errors: Partial<Record<keyof DnsRecordInput, string>> };

export function validateDnsRecord(input: unknown): DnsValidation {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Partial<Record<keyof DnsRecordInput, string>> = {};

  const type = String(raw.type ?? "").toUpperCase() as DnsRecordType;
  if (!DNS_RECORD_TYPES.includes(type)) errors.type = `Use one of ${DNS_RECORD_TYPES.join(", ")}.`;

  const name = String(raw.name ?? "").trim() || "@";
  if (!LABEL.test(name)) errors.name = 'Use "@" for the domain itself, or a name like "www".';

  const content = String(raw.content ?? "").trim();
  if (!content) errors.content = "Required.";
  else if (type === "A" && !IPV4.test(content)) errors.content = "Enter an IPv4 address, like 203.0.113.10.";
  else if (type === "AAAA" && !/^[0-9a-f:]+$/i.test(content)) errors.content = "Enter an IPv6 address.";
  else if ((type === "CNAME" || type === "MX") && !HOSTNAME.test(content)) errors.content = "Enter a hostname, like example.com.";
  else if (content.length > 2048) errors.content = "Too long.";

  const ttlRaw = Number(raw.ttl ?? 1);
  const ttl = Number.isInteger(ttlRaw) && (ttlRaw === 1 || (ttlRaw >= 60 && ttlRaw <= 86400)) ? ttlRaw : NaN;
  if (Number.isNaN(ttl)) errors.ttl = "Use Auto, or 60 to 86400 seconds.";

  const proxied = raw.proxied === true || raw.proxied === "true";
  if (proxied && DNS_RECORD_TYPES.includes(type) && !PROXIABLE_TYPES.includes(type)) {
    errors.proxied = `Only ${PROXIABLE_TYPES.join(", ")} records can be proxied.`;
  }

  let priority: number | undefined;
  if (type === "MX") {
    const value = Number(raw.priority ?? 10);
    if (!Number.isInteger(value) || value < 0 || value > 65535) errors.priority = "Use 0 to 65535.";
    else priority = value;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    record: { type, name, content, ttl, proxied, ...(priority !== undefined ? { priority } : {}) }
  };
}
