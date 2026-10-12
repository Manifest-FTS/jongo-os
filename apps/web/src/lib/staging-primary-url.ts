/**
 * Which staging address is THE staging link. Pure.
 *
 * A custom domain becomes the link only when it is attached and its
 * certificate is issued; anything less, and the .mfts.link fallback (which
 * always works) is used. So a domain whose DNS breaks later never leaves people
 * with a broken staging link.
 */

export type CustomStagingStatus = "pending_dns" | "verified" | "active" | "dns_lost" | "failed" | "removed";
export type CustomStagingSsl = "none" | "pending" | "issued" | "failed";

export type CustomDomainState = {
  hostname: string;
  status: CustomStagingStatus | string;
  sslStatus: CustomStagingSsl | string;
  createdAt: Date | string;
};

function byAge(a: CustomDomainState, b: CustomDomainState): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export function isServingCustomDomain(domain: CustomDomainState): boolean {
  return domain.status === "active" && domain.sslStatus === "issued";
}

export function resolvePrimaryStagingHost(input: {
  fallbackHost: string;
  customDomains: CustomDomainState[];
}): { host: string; source: "custom" | "fallback" } {
  const ready = input.customDomains.filter(isServingCustomDomain).sort(byAge)[0];
  return ready ? { host: ready.hostname.toLowerCase(), source: "custom" } : { host: input.fallbackHost.toLowerCase(), source: "fallback" };
}

/**
 * Every host staging content may reference (links written while one or another
 * address was in use), primary first. A staging-to-production rewrite replaces
 * all of them, not just the current link.
 */
export function stagingHostsForRewrite(input: { fallbackHost: string; customDomains: CustomDomainState[] }): string[] {
  const primary = resolvePrimaryStagingHost(input).host;
  const others = input.customDomains
    .filter((domain) => domain.status !== "removed")
    .sort(byAge)
    .map((domain) => domain.hostname.toLowerCase());
  return [...new Set([primary, input.fallbackHost.toLowerCase(), ...others].filter(Boolean))];
}
