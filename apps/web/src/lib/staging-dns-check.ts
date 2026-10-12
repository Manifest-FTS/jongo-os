/**
 * Does a custom staging hostname point at Jongo? Pure: the lookup itself is in
 * lib/staging-dns-lookup.ts.
 *
 * Accepted: a CNAME to the site's fallback host (site.stage.mfts.link), or A
 * records that are all the server's IP. A record behind Cloudflare's proxy is
 * refused with its own message: we cannot see where it points, and certificate
 * issuance through the proxy is unreliable (decided: DNS-only required).
 */

export type DnsObservation = {
  cnames: string[];
  a: string[];
  aaaa: string[];
  error?: "nxdomain" | "timeout" | "servfail";
};

export type DnsExpectation = { cnameTarget: string; targetIps: string[] };

export type DnsFailure = "no_record" | "points_elsewhere" | "cloudflare_proxied" | "ipv6_mismatch" | "lookup_failed";

export type DnsVerdict =
  | { ok: true; via: "cname" | "a_record" }
  | { ok: false; reason: DnsFailure; message: string; found: string[] };

// Cloudflare's published ranges: https://www.cloudflare.com/ips/
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"
];
const CLOUDFLARE_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n);
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return null;
  const [head, tail, extra] = ip.split("::");
  if (extra !== undefined) return null;
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined ? headParts.length !== 8 : missing < 1) return null;
  const groups = [...headParts, ...Array(tail === undefined ? 0 : missing).fill("0"), ...tailParts];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
}

function inRange(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split("/");
  const v6 = base.includes(":");
  const width = v6 ? 128n : 32n;
  const value = v6 ? ipv6ToBigInt(ip) : ipv4ToBigInt(ip);
  const network = v6 ? ipv6ToBigInt(base) : ipv4ToBigInt(base);
  if (value === null || network === null) return false;
  const shift = width - BigInt(Number(bitsText));
  return value >> shift === network >> shift;
}

export function isCloudflareIp(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  return (value.includes(":") ? CLOUDFLARE_V6 : CLOUDFLARE_V4).some((cidr) => inRange(value, cidr));
}

const norm = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

const MESSAGES: Record<DnsFailure, string> = {
  no_record: "We could not find the DNS record yet. Create it, then check again (new records can take a few minutes).",
  points_elsewhere: "The record exists but points somewhere else. Change it to the value shown, then check again.",
  cloudflare_proxied:
    "This record is proxied by Cloudflare (orange cloud). Switch it to DNS only (grey cloud) so we can verify it and issue the certificate.",
  ipv6_mismatch: "There is also an AAAA (IPv6) record for this name pointing elsewhere. Delete it, then check again.",
  lookup_failed: "DNS did not answer just now. That is usually temporary; try again in a minute."
};

function fail(reason: DnsFailure, found: string[] = []): DnsVerdict {
  return { ok: false, reason, message: MESSAGES[reason], found };
}

export function evaluateDns(observation: DnsObservation, expected: DnsExpectation): DnsVerdict {
  if (observation.error === "nxdomain") return fail("no_record");
  if (observation.error) return fail("lookup_failed");

  const cnames = observation.cnames.map(norm);
  const a = observation.a.map(norm);
  const aaaa = observation.aaaa.map(norm);
  const targetIps = new Set(expected.targetIps.map(norm));
  const found = [...cnames, ...a, ...aaaa];

  if ([...a, ...aaaa].some(isCloudflareIp)) return fail("cloudflare_proxied", found);
  if (cnames.includes(norm(expected.cnameTarget))) return { ok: true, via: "cname" };
  if (found.length === 0) return fail("no_record");

  if (cnames.length === 0 && a.length > 0 && a.every((ip) => targetIps.has(ip))) {
    if (aaaa.some((ip) => !targetIps.has(ip))) return fail("ipv6_mismatch", found);
    return { ok: true, via: "a_record" };
  }
  return fail("points_elsewhere", found);
}
