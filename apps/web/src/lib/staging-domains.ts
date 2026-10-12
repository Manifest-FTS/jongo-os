/**
 * Custom staging domains: add, verify, attach in Coolify, check SSL, remove,
 * and the hourly re-check. See docs/architecture/custom-staging-domains.md.
 *
 * Every decision is made by a pure, tested module; this file does the I/O:
 *   - which names are allowed       lib/staging-domain-rules.ts
 *   - who may claim a name          lib/staging-domain-claims.ts
 *   - whether DNS points at us      lib/staging-dns-check.ts
 *   - whether SSL is issued         lib/staging-ssl-check.ts
 *   - which address is THE link     lib/staging-primary-url.ts
 *
 * The .mfts.link fallback is always kept attached, so staging never stops
 * working because of a client's DNS.
 */

import { getDb } from "@/lib/db";
import {
  applyCoolifyApplicationDomains,
  applyCoolifyServiceDomains,
  coolifyFetch,
  getCoolifyAppStagingCapability,
  restartCoolifyService,
  triggerCoolifyDeploy
} from "@/lib/coolify";
import { extractResourceDomains, normalizeDomain } from "@/lib/coolify-primary-domain";
import { getTransferPriceList } from "@/lib/namecheap";
import { CLAIM_MESSAGES, decideClaim } from "@/lib/staging-domain-claims";
import {
  MAX_CUSTOM_STAGING_DOMAINS,
  pickFallbackHost,
  platformSuffixesFromEnv,
  validateCustomStagingHostname
} from "@/lib/staging-domain-rules";
import { evaluateDns } from "@/lib/staging-dns-check";
import { observeDns, resolveTargetIps } from "@/lib/staging-dns-lookup";
import { evaluateCertificate, SSL_MESSAGES } from "@/lib/staging-ssl-check";
import { probeCertificate } from "@/lib/staging-ssl-probe";
import { resolvePrimaryStagingHost, stagingHostsForRewrite, type CustomDomainState } from "@/lib/staging-primary-url";
import { runUrlRewrite } from "@/lib/wp-url-rewrite-run";

/* eslint-disable @typescript-eslint/no-explicit-any */

const VERIFY_COOLDOWN_MS = 15_000;
/** Attached in Coolify: every state from verified on, until removed. */
const ATTACHED_STATES = ["verified", "active", "dns_lost"];

export type StagingDomainRow = {
  id: string;
  siteId: string;
  hostname: string;
  status: string;
  sslStatus: string;
  cnameTarget: string;
  lastError: string | null;
  lastErrorReason: string | null;
  lastCheckedAt: Date | null;
  verifiedAt: Date | null;
  attachedAt: Date | null;
  sslIssuedAt: Date | null;
  sslExpiresAt: Date | null;
  createdAt: Date;
};

export type Outcome<T = undefined> = { ok: true; message: string; value?: T } | { ok: false; status: number; message: string };

// ---------------------------------------------------------------------------
// Context: the site's staging resource and its hosts
// ---------------------------------------------------------------------------

type StagingContext = {
  site: { id: string; organizationId: string; coolifyServiceUuid: string };
  stagingUuid: string;
  resourceKind: string;
  fallbackHost: string;
  productionHosts: string[];
};

async function readResourceHosts(uuid: string): Promise<string[]> {
  for (const path of [`/api/v1/services/${encodeURIComponent(uuid)}`, `/api/v1/applications/${encodeURIComponent(uuid)}`]) {
    try {
      const hosts = extractResourceDomains(await coolifyFetch(path));
      if (hosts.length) return hosts;
    } catch {
      // Try the other resource kind.
    }
  }
  return [];
}

async function loadContext(siteId: string): Promise<StagingContext | { error: string; status: number }> {
  const db: any = await getDb();
  if (!db) return { error: "The database is unavailable.", status: 503 };
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, organizationId: true, coolifyServiceUuid: true, coolifyProjectId: true }
  });
  const appUuid = site?.coolifyServiceUuid?.trim();
  if (!site || !appUuid) return { error: "This site is not linked to a Coolify resource.", status: 409 };

  const capability = await getCoolifyAppStagingCapability(appUuid, site.coolifyProjectId ?? undefined, { relaxedTargetMatch: true });
  if (!capability.applicationUuid) return { error: "Staging is not set up for this site yet. Turn staging on first.", status: 409 };

  const customHosts: Array<{ hostname: string }> = await db.stagingDomain.findMany({
    where: { siteId, status: { not: "removed" } },
    select: { hostname: true }
  });
  const attached = String(capability.fqdn ?? capability.stagingUrl ?? "")
    .split(",")
    .map(normalizeDomain)
    .filter(Boolean);
  const fallbackHost = pickFallbackHost(attached, platformSuffixesFromEnv(), customHosts.map((row) => row.hostname));
  if (!fallbackHost) return { error: "The staging copy has no address yet. Try again in a minute.", status: 409 };

  return {
    site: { id: site.id, organizationId: site.organizationId, coolifyServiceUuid: appUuid },
    stagingUuid: capability.applicationUuid,
    resourceKind: capability.resourceKind ?? "unknown",
    fallbackHost,
    productionHosts: await readResourceHosts(appUuid)
  };
}

/** Every host any OTHER Coolify resource serves: a name already in use there cannot be claimed. */
async function hostsServedElsewhere(excludeUuids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of ["/api/v1/services", "/api/v1/applications"]) {
    try {
      const list = await coolifyFetch(path);
      if (!Array.isArray(list)) continue;
      for (const resource of list) {
        if (excludeUuids.includes(String((resource as Record<string, unknown>)?.uuid ?? ""))) continue;
        out.push(...extractResourceDomains(resource));
      }
    } catch {
      // Best effort: the database index still stops a duplicate claim.
    }
  }
  return out;
}

async function audit(db: any, input: { organizationId: string; actorId?: string | null; siteId: string; actionType: string; details: Record<string, unknown> }) {
  try {
    await db.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorId: input.actorId ?? null,
        action: "site_updated",
        resourceType: "site_staging",
        resourceId: input.siteId,
        details: { actionType: input.actionType, ...input.details }
      }
    });
  } catch (error) {
    console.error("[staging-domains] audit write failed", error);
  }
}

async function rowsForSite(db: any, siteId: string): Promise<StagingDomainRow[]> {
  return db.stagingDomain.findMany({ where: { siteId, status: { not: "removed" } }, orderBy: { createdAt: "asc" } });
}

function primaryOf(rows: CustomDomainState[], fallbackHost: string): string {
  return resolvePrimaryStagingHost({ fallbackHost, customDomains: rows }).host;
}

// ---------------------------------------------------------------------------
// Coolify: attach / detach by setting the full list (fallback always included)
// ---------------------------------------------------------------------------

async function applyAttachedHosts(db: any, ctx: StagingContext): Promise<{ ok: boolean; message: string }> {
  const rows: StagingDomainRow[] = await db.stagingDomain.findMany({
    where: { siteId: ctx.site.id, status: { in: ATTACHED_STATES } },
    orderBy: { createdAt: "asc" }
  });
  // Fallback first: Coolify treats the first host as the resource's main URL,
  // and the fallback is the one that always works.
  const hosts = [...new Set([ctx.fallbackHost, ...rows.map((row) => row.hostname)])].map((host) => `https://${host}`);

  if (ctx.resourceKind === "service") {
    const result = await applyCoolifyServiceDomains(ctx.stagingUuid, hosts);
    if (!result.ok) return { ok: false, message: result.message };
    // Traefik only picks up new routers (and asks Let's Encrypt) on a restart.
    const restart = await restartCoolifyService(ctx.stagingUuid);
    return restart.ok ? { ok: true, message: "Attached." } : { ok: false, message: "Saved in Coolify, but the restart was refused. It will retry." };
  }

  const updated = await applyCoolifyApplicationDomains(ctx.stagingUuid, hosts);
  if (!updated) return { ok: false, message: "Coolify did not accept the domain change." };
  try {
    await triggerCoolifyDeploy(ctx.stagingUuid, "staging");
    return { ok: true, message: "Attached." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The redeploy was refused." };
  }
}

/**
 * WordPress redirects every host to its saved site URL. When the staging link
 * changes, rewrite the staging database from the old link to the new one, or
 * the fallback would redirect people to a domain that may not work.
 */
async function followPrimaryChange(db: any, ctx: StagingContext, before: string, actorId?: string | null): Promise<void> {
  const after = primaryOf(await rowsForSite(db, ctx.site.id), ctx.fallbackHost);
  if (after === before) return;
  let rowsChanged: number | null = null;
  let error: string | null = null;
  if (ctx.resourceKind === "service") {
    const result = await runUrlRewrite({ resourceUuid: ctx.stagingUuid, fromUrl: `https://${before}`, toUrl: `https://${after}`, apply: true });
    rowsChanged = result.ok ? result.rowsChanged : null;
    error = result.ok ? null : result.error;
  }
  await audit(db, {
    organizationId: ctx.site.organizationId,
    actorId,
    siteId: ctx.site.id,
    actionType: "staging_domain_primary_changed",
    details: { from: before, to: after, stagingUrl: `https://${after}`, rowsChanged, error }
  });
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export type StagingDomainsView = {
  fallbackHost: string;
  primaryHost: string;
  max: number;
  domains: Array<StagingDomainRow & { isPrimary: boolean; sslMessage: string | null }>;
};

export async function listStagingDomains(siteId: string): Promise<Outcome<StagingDomainsView>> {
  const ctx = await loadContext(siteId);
  if ("error" in ctx) return { ok: false, status: ctx.status, message: ctx.error };
  const db: any = await getDb();
  const rows = await rowsForSite(db, siteId);
  const primaryHost = primaryOf(rows, ctx.fallbackHost);
  return {
    ok: true,
    message: "",
    value: {
      fallbackHost: ctx.fallbackHost,
      primaryHost,
      max: MAX_CUSTOM_STAGING_DOMAINS,
      domains: rows.map((row) => ({
        ...row,
        isPrimary: row.hostname === primaryHost,
        sslMessage: row.lastErrorReason && SSL_MESSAGES[row.lastErrorReason] ? SSL_MESSAGES[row.lastErrorReason] : null
      }))
    }
  };
}

export async function addStagingDomain(input: { siteId: string; hostname: string; actorId: string }): Promise<Outcome<StagingDomainRow>> {
  const ctx = await loadContext(input.siteId);
  if ("error" in ctx) return { ok: false, status: ctx.status, message: ctx.error };
  const db: any = await getDb();

  const knownTlds = await getTransferPriceList()
    .then((list) => [...list.keys()])
    .catch(() => undefined);
  const validated = validateCustomStagingHostname(input.hostname, {
    platformSuffixes: platformSuffixesFromEnv(),
    productionHosts: ctx.productionHosts,
    knownTlds
  });
  if (!validated.ok) return { ok: false, status: 400, message: validated.message };
  const hostname = validated.hostname;

  const existing = await db.stagingDomain.findMany({
    where: { OR: [{ hostname }, { siteId: ctx.site.id }] },
    select: { hostname: true, siteId: true, status: true }
  });
  const claim = decideClaim(hostname, ctx.site.id, existing, {
    hostsInUseElsewhere: await hostsServedElsewhere([ctx.stagingUuid]),
    max: MAX_CUSTOM_STAGING_DOMAINS
  });
  if (!claim.ok) return { ok: false, status: 409, message: CLAIM_MESSAGES[claim.reason] };

  let row: StagingDomainRow;
  try {
    row = await db.stagingDomain.create({
      data: { siteId: ctx.site.id, hostname, cnameTarget: ctx.fallbackHost, createdById: input.actorId }
    });
  } catch (error) {
    // The partial unique index: someone else claimed it a moment ago.
    if ((error as { code?: string })?.code === "P2002") return { ok: false, status: 409, message: CLAIM_MESSAGES.taken_by_other_site };
    throw error;
  }

  await audit(db, {
    organizationId: ctx.site.organizationId,
    actorId: input.actorId,
    siteId: ctx.site.id,
    actionType: "staging_domain_added",
    details: { hostname, cnameTarget: ctx.fallbackHost }
  });
  return { ok: true, message: `Added. Create the DNS record shown, then click Verify.`, value: row };
}

/**
 * Checks DNS and, once it points at us, attaches the domain. On an attached
 * domain this is "check again": DNS plus the certificate.
 */
export async function verifyStagingDomain(input: { siteId: string; domainId: string; actorId?: string | null }): Promise<Outcome> {
  const db: any = await getDb();
  const row: StagingDomainRow | null = await db.stagingDomain.findFirst({ where: { id: input.domainId, siteId: input.siteId } });
  if (!row || row.status === "removed") return { ok: false, status: 404, message: "That staging domain no longer exists." };
  if (row.lastCheckedAt && Date.now() - new Date(row.lastCheckedAt).getTime() < VERIFY_COOLDOWN_MS) {
    return { ok: false, status: 429, message: "Checked a moment ago. Wait a few seconds and try again." };
  }

  const ctx = await loadContext(input.siteId);
  if ("error" in ctx) return { ok: false, status: ctx.status, message: ctx.error };
  const before = primaryOf(await rowsForSite(db, input.siteId), ctx.fallbackHost);

  const verdict = evaluateDns(await observeDns(row.hostname), {
    cnameTarget: row.cnameTarget,
    targetIps: await resolveTargetIps(row.cnameTarget)
  });
  const now = new Date();

  if (!verdict.ok) {
    const lost = row.status === "active" && verdict.reason !== "lookup_failed";
    await db.stagingDomain.update({
      where: { id: row.id },
      data: { lastCheckedAt: now, lastError: verdict.message, lastErrorReason: verdict.reason, ...(lost ? { status: "dns_lost" } : {}) }
    });
    if (lost) {
      await audit(db, { organizationId: ctx.site.organizationId, actorId: input.actorId, siteId: ctx.site.id, actionType: "staging_domain_dns_lost", details: { hostname: row.hostname, reason: verdict.reason } });
      await followPrimaryChange(db, ctx, before, input.actorId);
    }
    return { ok: false, status: 422, message: verdict.message };
  }

  if (row.status === "pending_dns" || row.status === "failed") {
    await db.stagingDomain.update({
      where: { id: row.id },
      data: { status: "verified", verifiedAt: now, lastCheckedAt: now, lastError: null, lastErrorReason: null }
    });
    await audit(db, { organizationId: ctx.site.organizationId, actorId: input.actorId, siteId: ctx.site.id, actionType: "staging_domain_verified", details: { hostname: row.hostname, via: verdict.via } });
  } else {
    await db.stagingDomain.update({
      where: { id: row.id },
      data: { lastCheckedAt: now, ...(row.status === "dns_lost" ? { status: "active", lastError: null, lastErrorReason: null } : {}) }
    });
  }

  const current: StagingDomainRow = await db.stagingDomain.findUnique({ where: { id: row.id } });
  if (current.status === "verified") {
    const attached = await applyAttachedHosts(db, ctx);
    if (!attached.ok) {
      await db.stagingDomain.update({ where: { id: row.id }, data: { lastError: `DNS is correct, but attaching failed: ${attached.message}`, lastErrorReason: "attach_failed" } });
      return { ok: false, status: 502, message: `DNS is correct, but attaching it to staging failed: ${attached.message} We will retry automatically.` };
    }
    await db.stagingDomain.update({ where: { id: row.id }, data: { status: "active", attachedAt: new Date(), sslStatus: "pending", lastError: null, lastErrorReason: null } });
    await audit(db, { organizationId: ctx.site.organizationId, actorId: input.actorId, siteId: ctx.site.id, actionType: "staging_domain_attached", details: { hostname: row.hostname } });
    return { ok: true, message: "Verified and attached. The certificate is being issued; this usually takes a few minutes." };
  }

  await checkCertificate(db, current);
  await followPrimaryChange(db, ctx, before, input.actorId);
  const after: StagingDomainRow = await db.stagingDomain.findUnique({ where: { id: row.id } });
  return {
    ok: true,
    message:
      after.sslStatus === "issued"
        ? "DNS and SSL are both working."
        : after.sslStatus === "failed"
          ? after.lastError ?? "The certificate could not be issued."
          : "DNS is correct. Still waiting for the certificate."
  };
}

async function checkCertificate(db: any, row: StagingDomainRow): Promise<void> {
  if (row.status !== "active" || !row.attachedAt) return;
  const verdict = evaluateCertificate(row.hostname, await probeCertificate(row.hostname), { attachedAt: row.attachedAt });
  if (verdict.status === "issued") {
    await db.stagingDomain.update({
      where: { id: row.id },
      data: {
        sslStatus: "issued",
        sslExpiresAt: verdict.expiresAt,
        ...(row.sslStatus !== "issued" ? { sslIssuedAt: new Date() } : {}),
        lastError: null,
        lastErrorReason: null
      }
    });
    return;
  }
  await db.stagingDomain.update({
    where: { id: row.id },
    data: { sslStatus: verdict.status, lastError: SSL_MESSAGES[verdict.reason] ?? null, lastErrorReason: verdict.reason }
  });
}

export async function removeStagingDomain(input: { siteId: string; domainId: string; actorId: string }): Promise<Outcome> {
  const db: any = await getDb();
  const row: StagingDomainRow | null = await db.stagingDomain.findFirst({ where: { id: input.domainId, siteId: input.siteId } });
  if (!row || row.status === "removed") return { ok: false, status: 404, message: "That staging domain no longer exists." };

  const ctx = await loadContext(input.siteId);
  const wasAttached = ATTACHED_STATES.includes(row.status);
  const before = "error" in ctx ? "" : primaryOf(await rowsForSite(db, input.siteId), ctx.fallbackHost);

  await db.stagingDomain.update({ where: { id: row.id }, data: { status: "removed", removedAt: new Date() } });

  let message = "Removed.";
  if (!("error" in ctx)) {
    if (wasAttached) {
      const detached = await applyAttachedHosts(db, ctx);
      message = detached.ok ? "Removed from staging." : `Removed here, but Coolify did not accept the change: ${detached.message}`;
    }
    await followPrimaryChange(db, ctx, before, input.actorId);
    await audit(db, { organizationId: ctx.site.organizationId, actorId: input.actorId, siteId: ctx.site.id, actionType: "staging_domain_removed", details: { hostname: row.hostname } });
  }
  return { ok: true, message: `${message} Staging is back on ${"error" in ctx ? "its .mfts.link address" : ctx.fallbackHost} if this was the main link.` };
}

/** When the staging copy itself is destroyed: its custom domains go with it (nothing to detach). */
export async function releaseStagingDomainsForSite(siteId: string): Promise<number> {
  const db: any = await getDb();
  if (!db) return 0;
  const result = await db.stagingDomain.updateMany({ where: { siteId, status: { not: "removed" } }, data: { status: "removed", removedAt: new Date() } });
  return result.count;
}

// ---------------------------------------------------------------------------
// Readers for everywhere a staging link is shown or rewritten
// ---------------------------------------------------------------------------

function hostOf(url: string | null | undefined): string {
  return normalizeDomain(url ?? "");
}

/**
 * THE staging URL for a site, given the URL the caller already resolved from
 * Coolify (the fallback). A custom domain wins only when it is active with an
 * issued certificate.
 */
export async function primaryStagingUrl(siteId: string, fallbackUrl: string | null | undefined): Promise<string | undefined> {
  const fallbackHost = hostOf(fallbackUrl);
  if (!fallbackHost) return fallbackUrl ?? undefined;
  try {
    const db: any = await getDb();
    if (!db) return fallbackUrl ?? undefined;
    const rows = await rowsForSite(db, siteId);
    const primary = resolvePrimaryStagingHost({ fallbackHost, customDomains: rows });
    return primary.source === "custom" ? `https://${primary.host}` : (fallbackUrl ?? undefined);
  } catch {
    return fallbackUrl ?? undefined;
  }
}

/** Every staging URL content may reference, primary first: what a staging-to-production rewrite replaces. */
export async function stagingUrlsForRewrite(siteId: string, fallbackUrl: string | null | undefined): Promise<string[]> {
  const fallbackHost = hostOf(fallbackUrl);
  if (!fallbackHost) return fallbackUrl ? [fallbackUrl] : [];
  try {
    const db: any = await getDb();
    const rows = db ? await rowsForSite(db, siteId) : [];
    return stagingHostsForRewrite({ fallbackHost, customDomains: rows }).map((host) => `https://${host}`);
  } catch {
    return [fallbackUrl as string];
  }
}

// ---------------------------------------------------------------------------
// Hourly re-check (called from the backup-reconcile pass)
// ---------------------------------------------------------------------------

export type StagingDomainReconcileResult = { checked: number; attached: number; dnsLost: number; recovered: number; sslIssued: number; sslFailed: number };

export async function reconcileStagingDomains(limit = 10): Promise<StagingDomainReconcileResult> {
  const result: StagingDomainReconcileResult = { checked: 0, attached: 0, dnsLost: 0, recovered: 0, sslIssued: 0, sslFailed: 0 };
  const db: any = await getDb();
  if (!db) return result;

  const rows: StagingDomainRow[] = await db.stagingDomain.findMany({
    where: { status: { in: ATTACHED_STATES } },
    orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }],
    take: limit
  });

  for (const row of rows) {
    result.checked += 1;
    const before = row.status;
    const sslBefore = row.sslStatus;
    // verify does the work (DNS, attach retry, certificate, primary switch);
    // the cooldown is skipped by clearing lastCheckedAt for this pass.
    await db.stagingDomain.update({ where: { id: row.id }, data: { lastCheckedAt: null } });
    await verifyStagingDomain({ siteId: row.siteId, domainId: row.id, actorId: null }).catch((error) =>
      console.error(`[staging-domains] re-check of ${row.hostname} failed`, error)
    );
    const after: StagingDomainRow | null = await db.stagingDomain.findUnique({ where: { id: row.id } });
    if (!after) continue;
    if (before === "verified" && after.status === "active") result.attached += 1;
    if (before !== "dns_lost" && after.status === "dns_lost") result.dnsLost += 1;
    if (before === "dns_lost" && after.status === "active") result.recovered += 1;
    if (sslBefore !== "issued" && after.sslStatus === "issued") result.sslIssued += 1;
    if (sslBefore !== "failed" && after.sslStatus === "failed") result.sslFailed += 1;
  }
  return result;
}
