/**
 * In-app fixes ("remedies") for problems that used to end in "do it in
 * Coolify". A response that can't finish something returns a remedy next to
 * its message; RemedyButton shows it, and /api/sites/[siteId]/remedies (or the
 * domain-charge variant) runs it. Pure: no I/O, so the rules are unit-tested.
 */
import type { UserPermissions } from "@/lib/permissions";

export type RemedyAction =
  | "restart_site"
  | "apply_site_domain"
  | "retry_staging_cleanup"
  | "retry_staging_provision"
  | "retry_staging_database"
  | "retry_site_delete"
  | "retry_domain_order"
  | "refund_domain_order";

export type RemedyTarget = "production" | "staging";

export type Remedy = {
  action: RemedyAction;
  label: string;
  target?: RemedyTarget;
  params?: Record<string, string>;
};

export const SITE_REMEDY_ACTIONS = [
  "restart_site",
  "apply_site_domain",
  "retry_staging_cleanup",
  "retry_staging_provision",
  "retry_staging_database",
  "retry_site_delete"
] as const satisfies readonly RemedyAction[];

export const DOMAIN_REMEDY_ACTIONS = ["retry_domain_order", "refund_domain_order"] as const satisfies readonly RemedyAction[];

const RULES: Record<RemedyAction, { allowed: (p: Partial<UserPermissions>) => boolean; denied: string; cooldownMs: number }> = {
  restart_site: {
    allowed: (p) => Boolean(p.canPromoteStaging),
    denied: "You can't restart this site.",
    cooldownMs: 30_000
  },
  apply_site_domain: {
    allowed: (p) => Boolean(p.canEditDomains),
    denied: "Only the client's admins can change the site's address.",
    cooldownMs: 30_000
  },
  retry_staging_cleanup: {
    allowed: (p) => Boolean(p.canManageStagingEnvironment),
    denied: "Only the client's admins can remove a staging copy.",
    cooldownMs: 30_000
  },
  retry_staging_provision: {
    allowed: (p) => Boolean(p.canManageStagingEnvironment),
    denied: "Only the client's admins can set up staging.",
    cooldownMs: 60_000
  },
  retry_staging_database: {
    // Rewrites staging's own database only, like a sync.
    allowed: (p) => Boolean(p.canSyncStaging),
    denied: "You can't refresh staging's database.",
    cooldownMs: 60_000
  },
  retry_site_delete: {
    allowed: (p) => Boolean(p.canDeleteSite),
    denied: "Only the client's admins can delete this app.",
    cooldownMs: 30_000
  },
  retry_domain_order: {
    allowed: (p) => Boolean(p.isPlatformAdmin),
    denied: "Only platform admins can retry domain orders.",
    cooldownMs: 30_000
  },
  refund_domain_order: {
    allowed: (p) => Boolean(p.isPlatformAdmin),
    denied: "Only platform admins can refund domain orders.",
    cooldownMs: 0
  }
};

export function isRemedyAction(value: unknown): value is RemedyAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RULES, value);
}

export function canRunRemedy(action: RemedyAction, permissions: Partial<UserPermissions>): { ok: true } | { ok: false; message: string } {
  const rule = isRemedyAction(action) ? RULES[action] : null;
  if (!rule) return { ok: false, message: "Unknown action." };
  return rule.allowed(permissions) ? { ok: true } : { ok: false, message: rule.denied };
}

export function remedyCooldownMs(action: RemedyAction): number {
  return RULES[action]?.cooldownMs ?? 30_000;
}

export function remedyGateKey(scopeId: string, action: RemedyAction, target?: RemedyTarget): string {
  return `${scopeId}:${action}:${target ?? "-"}`;
}

function labelFor(action: RemedyAction, target?: RemedyTarget): string {
  switch (action) {
    case "restart_site":
      return target === "staging" ? "Restart staging" : "Restart site";
    case "apply_site_domain":
      return "Apply address";
    case "retry_staging_cleanup":
      return "Remove old staging copy";
    case "retry_staging_provision":
    case "retry_staging_database":
      return "Try again";
    case "retry_site_delete":
      return "Retry delete";
    case "retry_domain_order":
      return "Retry order";
    case "refund_domain_order":
      return "Refund";
  }
}

export function remedy(action: RemedyAction, extra: { target?: RemedyTarget; params?: Record<string, string>; label?: string } = {}): Remedy {
  return {
    action,
    label: extra.label ?? labelFor(action, extra.target),
    ...(extra.target ? { target: extra.target } : {}),
    ...(extra.params ? { params: extra.params } : {})
  };
}
