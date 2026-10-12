/**
 * Whether a site may claim a custom staging hostname. Pure.
 *
 * The database also enforces uniqueness (a partial unique index on live
 * hostnames), so two sites racing for the same name cannot both win; this is
 * the check that produces a useful message before that.
 */

import { MAX_CUSTOM_STAGING_DOMAINS } from "./staging-domain-rules";

export type ExistingClaim = { hostname: string; siteId: string; status: string };

export type ClaimDecision =
  | { ok: true }
  | { ok: false; reason: "already_added" | "taken_by_other_site" | "in_use_elsewhere" | "limit_reached" };

export const CLAIM_MESSAGES: Record<Exclude<ClaimDecision, { ok: true }>["reason"], string> = {
  already_added: "This site already has that staging domain.",
  taken_by_other_site: "That hostname is already in use by another site on Jongo.",
  in_use_elsewhere: "That hostname is already served by another app on Jongo.",
  limit_reached: `A site can have up to ${MAX_CUSTOM_STAGING_DOMAINS} custom staging domains. Remove one first.`
};

export function decideClaim(
  hostname: string,
  siteId: string,
  existing: ExistingClaim[],
  options: { hostsInUseElsewhere: string[]; max?: number }
): ClaimDecision {
  const host = hostname.trim().toLowerCase();
  const live = existing.filter((claim) => claim.status !== "removed");

  const match = live.find((claim) => claim.hostname.trim().toLowerCase() === host);
  if (match) return { ok: false, reason: match.siteId === siteId ? "already_added" : "taken_by_other_site" };

  if (options.hostsInUseElsewhere.some((other) => other.trim().toLowerCase() === host)) {
    return { ok: false, reason: "in_use_elsewhere" };
  }

  const max = options.max ?? MAX_CUSTOM_STAGING_DOMAINS;
  if (live.filter((claim) => claim.siteId === siteId).length >= max) return { ok: false, reason: "limit_reached" };

  return { ok: true };
}
