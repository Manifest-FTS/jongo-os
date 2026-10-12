/**
 * Which hostnames a client may use as a custom staging domain. Pure.
 *
 * See docs/architecture/custom-staging-domains.md. In short: a subdomain of the
 * client's own domain (staging.clientsite.com), never an apex (that is their
 * production name and cannot be a CNAME), never one of Jongo's own platform
 * domains, never an IP or a wildcard.
 */

import { parseDomain } from "./domain-search";

export const MAX_CUSTOM_STAGING_DOMAINS = 2;

/** Jongo's own domains. Combined with the configured platform suffixes. */
export const DEFAULT_BLOCKED_SUFFIXES = ["mfts.link", "manifest-fts.com", "jongo.app"];

export type HostnameRejection =
  | "empty"
  | "invalid"
  | "ip_address"
  | "wildcard"
  | "apex"
  | "platform_domain"
  | "production_domain"
  | "too_long";

const MESSAGES: Record<HostnameRejection, string> = {
  empty: "Enter the staging address you want to use, like staging.yoursite.com.",
  invalid: "That is not a valid hostname. Use letters, digits and hyphens, like staging.yoursite.com.",
  ip_address: "Use a hostname, not an IP address.",
  wildcard: "Wildcard addresses are not supported. Enter one exact hostname.",
  apex: "Use a subdomain such as staging.yoursite.com. The bare domain is your production address and cannot point at staging.",
  platform_domain: "That address belongs to Jongo. Use a hostname on your own domain.",
  production_domain: "That is one of this site's production addresses. Pick a separate name for staging.",
  too_long: "That hostname is longer than DNS allows (253 characters)."
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lowercase, punycode, no scheme / path / port / trailing dot: the form DNS and
 * Coolify use. Anything that is not even parseable is returned trimmed and
 * lowercased, for validation to reject with a message.
 */
export function normalizeHostname(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return raw.toLowerCase().replace(/\.$/, "");
  }
}

function matchesSuffix(host: string, suffix: string): boolean {
  const s = normalizeHostname(suffix);
  return Boolean(s) && (host === s || host.endsWith(`.${s}`));
}

export type HostnameValidation = { ok: true; hostname: string } | { ok: false; reason: HostnameRejection; message: string };

function reject(reason: HostnameRejection): HostnameValidation {
  return { ok: false, reason, message: MESSAGES[reason] };
}

export function validateCustomStagingHostname(
  input: string,
  context: { platformSuffixes: string[]; productionHosts: string[]; knownTlds?: Iterable<string> }
): HostnameValidation {
  const host = normalizeHostname(input);
  if (!host) return reject("empty");
  if (host.length > 253) return reject("too_long");
  if (host.includes("*")) return reject("wildcard");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return reject("ip_address");

  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return reject("invalid");

  const blocked = [...DEFAULT_BLOCKED_SUFFIXES, ...context.platformSuffixes];
  if (blocked.some((suffix) => matchesSuffix(host, suffix))) return reject("platform_domain");

  if (context.productionHosts.map(normalizeHostname).includes(host)) return reject("production_domain");

  // A registrable domain (one label + a known ending, co.uk included) is an apex.
  if (parseDomain(host, context.knownTlds)) return reject("apex");

  return { ok: true, hostname: host };
}

export function canAddCustomStagingDomain(existingCount: number, max: number = MAX_CUSTOM_STAGING_DOMAINS): boolean {
  return existingCount < max;
}

/**
 * The always-working fallback among the hosts the staging resource has: the
 * first on a platform domain (wildcard DNS, so it resolves with no setup),
 * never one of the client's custom domains. Empty when there is none.
 */
export function pickFallbackHost(attachedHosts: string[], platformSuffixes: string[], customHosts: string[] = []): string {
  const custom = new Set(customHosts.map(normalizeHostname));
  const hosts = attachedHosts.map(normalizeHostname).filter((host) => host && !custom.has(host));
  const suffixes = [...DEFAULT_BLOCKED_SUFFIXES, ...platformSuffixes];
  return hosts.find((host) => suffixes.some((suffix) => matchesSuffix(host, suffix))) ?? hosts[0] ?? "";
}

/** The platform's own suffixes: Jongo's domains plus any configured ones. */
export function platformSuffixesFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return [env.JONGO_PLATFORM_DOMAIN_SUFFIXES, env.STAGING_DOMAIN_SUFFIX]
    .flatMap((value) => String(value ?? "").split(/[,\s]+/))
    .map(normalizeHostname)
    .filter(Boolean);
}
