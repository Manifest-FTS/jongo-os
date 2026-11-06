/**
 * Production domains: one primary (the client's domain, e.g. fuscarino.com)
 * that WordPress saves and every link uses, plus fallbacks (Jongo's own
 * address, e.g. fuscarino.manifest-fts.com) that keep working if the client's
 * domain lapses.
 *
 * Making a host primary:
 *   1. puts it first in Coolify (the order Traefik treats as the main URL);
 *   2. rewrites the WordPress database from every other host to it, so
 *      siteurl/home and content links say the primary;
 *   3. installs a small must-use plugin so a visit on a fallback host is
 *      served there instead of being redirected to the primary.
 *
 * The rules are in production-domain-rules.ts (pure, tested).
 */
import { getDb } from "@/lib/db";
import {
  applyCoolifyApplicationDomains,
  applyCoolifyServiceDomains,
  coolifyFetch,
  restartCoolifyService,
  triggerCoolifyDeploy
} from "@/lib/coolify";
import { extractResourceDomains } from "@/lib/coolify-primary-domain";
import { reportStep, withStep } from "@/lib/progress";
import {
  buildFallbackPlugin,
  choosePrimary,
  describeHosts,
  FALLBACK_PLUGIN_FILE,
  isFallbackHost,
  isSafeHost,
  orderHosts,
  type DomainRow
} from "@/lib/production-domain-rules";
import { platformSuffixesFromEnv } from "@/lib/staging-domain-rules";
import { evaluateDns } from "@/lib/staging-dns-check";
import { observeDns, resolveTargetIps } from "@/lib/staging-dns-lookup";
import { isSshHostConfigured, runHostScript } from "@/lib/ssh-exec";
import { runUrlRewrite } from "@/lib/wp-url-rewrite-run";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Kind = "service" | "application";
type Resource = { kind: Kind; hosts: string[] };

export type Outcome<T = undefined> = { ok: true; message: string; value?: T } | { ok: false; status: number; message: string };

async function readResource(uuid: string): Promise<Resource | null> {
  for (const kind of ["service", "application"] as const) {
    try {
      const resource = await coolifyFetch(`/api/v1/${kind}s/${encodeURIComponent(uuid)}`);
      if (resource && typeof resource === "object") return { kind, hosts: extractResourceDomains(resource) };
    } catch {
      // Try the other kind.
    }
  }
  return null;
}

async function loadSite(siteId: string) {
  const db: any = await getDb();
  if (!db) return null;
  return db.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      organizationId: true,
      coolifyServiceUuid: true,
      primaryDomain: true,
      primaryDomainDnsStatus: true,
      primaryDomainCheckedAt: true,
      primaryDomainError: true
    }
  });
}

export type ProductionDomainsView = {
  domains: DomainRow[];
  primary: string | null;
  dnsStatus: string | null;
  dnsMessage: string | null;
  checkedAt: string | null;
};

export async function listProductionDomains(siteId: string): Promise<Outcome<ProductionDomainsView>> {
  const site = await loadSite(siteId);
  const uuid = site?.coolifyServiceUuid?.trim();
  if (!site || !uuid) return { ok: false, status: 409, message: "This app isn't linked to a running site yet." };
  const resource = await readResource(uuid);
  if (!resource) return { ok: false, status: 503, message: "Hosting isn't reachable right now. Try again in a minute." };
  const suffixes = platformSuffixesFromEnv();
  const primary = choosePrimary(resource.hosts, site.primaryDomain, suffixes);
  const watched = primary && site.primaryDomain === primary;
  return {
    ok: true,
    message: "",
    value: {
      domains: describeHosts(orderHosts(resource.hosts, primary ?? ""), primary, suffixes),
      primary,
      dnsStatus: watched ? site.primaryDomainDnsStatus ?? null : null,
      dnsMessage: watched ? site.primaryDomainError ?? null : null,
      checkedAt: watched && site.primaryDomainCheckedAt ? new Date(site.primaryDomainCheckedAt).toISOString() : null
    }
  };
}

/** THE production URL for links, notifications and rewrites. */
export async function primaryProductionUrl(siteId: string): Promise<string | undefined> {
  try {
    const site = await loadSite(siteId);
    const host = site?.primaryDomain?.trim().toLowerCase();
    return host && isSafeHost(host) ? `https://${host}` : undefined;
  } catch {
    return undefined;
  }
}

function wordpressContainerScript(resourceUuid: string, body: string, env: Record<string, string> = {}): string {
  const q = (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const exports = Object.entries(env).map(([key, value]) => `${key}=${q(value)}\nexport ${key}`).join("\n");
  return `set -uo pipefail
RUUID=${q(resourceUuid)}
${exports}
CONTAINERS=$(docker ps --format '{{.Names}}' | grep -E "(^|-)$RUUID($|-)" || true)
WP_CONTAINER=""
while IFS= read -r c; do
  case "$c" in wordpress-*) WP_CONTAINER="$c";; esac
done <<EOF
$CONTAINERS
EOF
[ -n "$WP_CONTAINER" ] || { echo 'JONGO_RESULT=no_wordpress_container'; exit 0; }
${body}
`;
}

/** Install (or remove, when there is no fallback) the fallback-address plugin. */
export async function syncFallbackPlugin(resourceUuid: string, primary: string, fallbacks: string[]): Promise<{ ok: boolean; skipped?: boolean; message?: string }> {
  if (!isSshHostConfigured()) return { ok: false, message: "The server connection isn't configured." };
  const plugin = buildFallbackPlugin(primary, fallbacks);
  const body = plugin
    ? `docker exec -i -e JONGO_PLUGIN="$JONGO_PLUGIN" "$WP_CONTAINER" sh -c 'd=/var/www/html/wp-content; [ -d "$d" ] || { echo JONGO_RESULT=no_wp_content; exit 0; }; mkdir -p "$d/mu-plugins" && printf %s "$JONGO_PLUGIN" | base64 -d > "$d/mu-plugins/${FALLBACK_PLUGIN_FILE}.tmp" && mv "$d/mu-plugins/${FALLBACK_PLUGIN_FILE}.tmp" "$d/mu-plugins/${FALLBACK_PLUGIN_FILE}" && (chown -R www-data:www-data "$d/mu-plugins" 2>/dev/null || true) && echo JONGO_RESULT=ok'`
    : `docker exec "$WP_CONTAINER" sh -c 'rm -f /var/www/html/wp-content/mu-plugins/${FALLBACK_PLUGIN_FILE}; echo JONGO_RESULT=ok'`;
  const run = await runHostScript(
    wordpressContainerScript(resourceUuid, body, plugin ? { JONGO_PLUGIN: Buffer.from(plugin, "utf8").toString("base64") } : {}),
    { timeoutMs: 60_000 }
  );
  if (run.transportError) return { ok: false, message: run.transportError };
  const result = /JONGO_RESULT=(\S+)/.exec(run.stdout)?.[1];
  if (result === "no_wordpress_container") return { ok: true, skipped: true };
  if (result !== "ok") return { ok: false, message: "The backup address couldn't be set up on the site." };
  return { ok: true };
}

async function audit(db: any, input: { organizationId: string; actorId?: string | null; siteId: string; actionType: string; details: Record<string, unknown> }) {
  try {
    await db.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorId: input.actorId ?? null,
        action: "site_updated",
        resourceType: "site",
        resourceId: input.siteId,
        details: { actionType: input.actionType, ...input.details }
      }
    });
  } catch (error) {
    console.error("[production-domains] audit write failed", error);
  }
}

/**
 * Make `host` the primary. Safe to run again: each step converges (Coolify
 * order, database rewrite, plugin), so "Try again" finishes a partial run.
 */
export async function setPrimaryProductionDomain(input: { siteId: string; host: string; actorId: string }): Promise<Outcome> {
  const db: any = await getDb();
  const site = await loadSite(input.siteId);
  const uuid = site?.coolifyServiceUuid?.trim();
  if (!db || !site || !uuid) return { ok: false, status: 409, message: "This app isn't linked to a running site yet." };

  const host = input.host.trim().toLowerCase();
  const resource = await withStep("read", "Reading the site's addresses", () => readResource(uuid));
  if (!resource) return { ok: false, status: 503, message: "Hosting isn't reachable right now, so nothing changed. Try again in a minute." };
  const hosts = orderHosts(resource.hosts, "");
  if (!hosts.includes(host) || !isSafeHost(host)) {
    return { ok: false, status: 400, message: "That address isn't connected to this site." };
  }
  const previousPrimary = choosePrimary(hosts, site.primaryDomain, platformSuffixesFromEnv());
  const ordered = orderHosts(hosts, host);
  const urls = ordered.map((h) => `https://${h}`);

  // 1. Coolify: primary first, every other host kept.
  if (hosts[0] !== host) {
    const applied = await withStep("order", "Making it the main address", async () => {
      if (resource.kind === "service") {
        const result = await applyCoolifyServiceDomains(uuid, urls);
        if (!result.ok) return false;
        return (await restartCoolifyService(uuid)).ok;
      }
      if (!(await applyCoolifyApplicationDomains(uuid, urls))) return false;
      await triggerCoolifyDeploy(uuid, "production");
      return true;
    }, Boolean);
    if (!applied) return { ok: false, status: 502, message: "Hosting didn't accept the change. Nothing else was changed; try again." };
  } else {
    reportStep("order", "Making it the main address", "done");
  }

  // Saved now: links and notifications follow the choice even if a later step needs a retry.
  await db.site.update({
    where: { id: site.id },
    data: { primaryDomain: host, primaryDomainDnsStatus: null, primaryDomainError: null, primaryDomainCheckedAt: null }
  });

  // 2. WordPress database: every other address becomes the primary.
  let rowsChanged = 0;
  let rewriteError: string | null = null;
  let isWordPress = resource.kind === "service";
  if (isWordPress) {
    await withStep("database", "Saving the address in WordPress", async () => {
      for (const other of ordered.filter((h) => h !== host)) {
        const result = await runUrlRewrite({ resourceUuid: uuid, fromUrl: `https://${other}`, toUrl: `https://${host}`, apply: true });
        if (!result.ok) {
          if (/No running WordPress container/i.test(result.error ?? "")) {
            isWordPress = false;
            return true;
          }
          rewriteError = result.error ?? "The WordPress database wasn't updated.";
          return false;
        }
        rowsChanged += result.rowsChanged;
      }
      return true;
    }, Boolean);
  }

  // 3. Fallback hosts keep working without redirecting to the primary.
  let pluginError: string | null = null;
  if (isWordPress && !rewriteError) {
    const plugin = await withStep("fallback", "Keeping the backup address working", () =>
      syncFallbackPlugin(uuid, host, ordered.filter((h) => h !== host && isFallbackHost(h, platformSuffixesFromEnv()))), (r) => r.ok);
    if (!plugin.ok) pluginError = plugin.message ?? "The backup address couldn't be set up.";
  }

  await audit(db, {
    organizationId: site.organizationId,
    actorId: input.actorId,
    siteId: site.id,
    actionType: "production_primary_domain_set",
    details: { from: previousPrimary, to: host, hosts: ordered, rowsChanged, rewriteError, pluginError }
  });

  if (rewriteError) {
    return { ok: false, status: 502, message: `${host} is now the main address, but WordPress still has the old one saved. Try again to finish. (${rewriteError})` };
  }
  if (pluginError) {
    return { ok: false, status: 502, message: `${host} is now the main address. The backup address didn't finish setting up; try again.` };
  }
  return { ok: true, message: `${host} is now the main address.` };
}

// ---------------------------------------------------------------------------
// Hourly watch: does the primary still point at the server?
// ---------------------------------------------------------------------------

export type PrimaryDomainWatchResult = { checked: number; lost: number; recovered: number };

export async function watchPrimaryDomains(limit = 20): Promise<PrimaryDomainWatchResult> {
  const out: PrimaryDomainWatchResult = { checked: 0, lost: 0, recovered: 0 };
  const db: any = await getDb();
  if (!db) return out;
  const suffixes = platformSuffixesFromEnv();
  const sites = await db.site.findMany({
    where: { deletedAt: null, primaryDomain: { not: null }, NOT: [{ coolifyServiceUuid: null }] },
    orderBy: { primaryDomainCheckedAt: { sort: "asc", nulls: "first" } },
    take: limit,
    select: { id: true, organizationId: true, coolifyServiceUuid: true, primaryDomain: true, primaryDomainDnsStatus: true }
  });
  for (const site of sites) {
    const host = String(site.primaryDomain).toLowerCase();
    if (isFallbackHost(host, suffixes)) {
      await db.site.update({ where: { id: site.id }, data: { primaryDomainDnsStatus: "ok", primaryDomainError: null, primaryDomainCheckedAt: new Date() } });
      continue;
    }
    const resource = await readResource(site.coolifyServiceUuid);
    const fallback = resource?.hosts.find((h) => isFallbackHost(h, suffixes));
    if (!fallback) continue; // Nothing to compare against; try next hour.
    out.checked += 1;
    const verdict = evaluateDns(await observeDns(host), { cnameTarget: fallback, targetIps: await resolveTargetIps(fallback) });
    // Production domains are often behind Cloudflare's proxy on purpose; that counts as pointing here.
    const reason = "reason" in verdict ? verdict.reason : null;
    const ok = verdict.ok || reason === "cloudflare_proxied";
    const status = ok ? "ok" : reason === "lookup_failed" ? "unknown" : "dns_lost";
    const message = ok || status === "unknown"
      ? null
      : `${host} no longer points to this site (${"message" in verdict ? verdict.message : "DNS changed"}). Visitors can still use https://${fallback}.`;
    if (status === "dns_lost" && site.primaryDomainDnsStatus !== "dns_lost") out.lost += 1;
    if (status === "ok" && site.primaryDomainDnsStatus === "dns_lost") out.recovered += 1;
    await db.site.update({
      where: { id: site.id },
      data: { primaryDomainDnsStatus: status, primaryDomainError: message, primaryDomainCheckedAt: new Date() }
    });
    if (status !== site.primaryDomainDnsStatus && (status === "dns_lost" || site.primaryDomainDnsStatus === "dns_lost")) {
      await audit(db, {
        organizationId: site.organizationId,
        siteId: site.id,
        actionType: status === "dns_lost" ? "production_primary_domain_dns_lost" : "production_primary_domain_dns_recovered",
        details: { host, fallback, reason: "reason" in verdict ? verdict.reason : null }
      });
    }
  }
  return out;
}
