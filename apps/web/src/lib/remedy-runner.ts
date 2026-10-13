/**
 * Runs a site remedy (see lib/remedies.ts). Staging and delete remedies call
 * the existing route handlers in-process, so their permission checks, matching
 * rules and audit entries stay the only implementation of those actions:
 * "retry cleanup" is exactly "turn staging off and remove the copy" again, and
 * removes only what that path identifies as this app's staging.
 */
import { remedy, type Remedy, type RemedyAction, type RemedyTarget } from "@/lib/remedies";

export type RemedyOutcome = { ok: boolean; status: number; message: string; remedy?: Remedy | null };

type SiteRow = {
  id: string;
  organizationId: string;
  coolifyServiceUuid: string | null;
  stagingTargetUuid: string | null;
  temporaryDomainSlug: string | null;
  temporaryDomainSuffix: string | null;
};

/** A copy of the incoming request with a new method/body, for an in-process route call. */
function forwardedRequest(req: Request, url: string, method: string, body: unknown): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(url, { method, headers, body: JSON.stringify(body) });
}

/** Reads a route handler's JSON reply as a remedy outcome, in plain words. */
async function outcomeFrom(response: Response, fallback: string, next: Remedy | null): Promise<RemedyOutcome> {
  const payload: any = await response.json().catch(() => null);
  const ok = response.ok && payload?.ok !== false && payload?.destroyed !== false;
  const { toClientFacingStagingMessage } = await import("@/lib/staging-client-copy");
  const text = toClientFacingStagingMessage(payload?.message ?? payload?.error) ?? fallback;
  return { ok, status: ok ? 200 : response.status >= 400 ? response.status : 409, message: text, remedy: ok ? null : next };
}

export async function runSiteRemedy(input: {
  req: Request;
  routeSiteId: string;
  site: SiteRow;
  action: RemedyAction;
  target?: RemedyTarget;
}): Promise<RemedyOutcome> {
  const { req, routeSiteId, site, action, target } = input;
  const origin = new URL(req.url).origin;

  switch (action) {
    case "restart_site": {
      const uuid = target === "staging" ? site.stagingTargetUuid?.trim() : site.coolifyServiceUuid?.trim();
      if (!uuid) {
        return { ok: false, status: 409, message: target === "staging" ? "There's no staging copy to restart." : "This app isn't linked to a running site yet." };
      }
      const { triggerCoolifyDeploy } = await import("@/lib/coolify");
      try {
        const result = await triggerCoolifyDeploy(uuid, target ?? "production");
        return {
          ok: true,
          status: 200,
          message: result.action === "deploy"
            ? "Redeploy started. The site is back in a minute or two."
            : "Restarted. Changes show within a minute."
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "the server did not accept it";
        return { ok: false, status: 502, message: `The restart didn't go through (${reason}). Try again in a minute.`, remedy: remedy("restart_site", { target }) };
      }
    }

    case "apply_site_domain": {
      const uuid = site.coolifyServiceUuid?.trim();
      const { buildTemporaryProductionDomain } = await import("@/lib/temporary-domains");
      const domain = buildTemporaryProductionDomain({ slug: site.temporaryDomainSlug, suffix: site.temporaryDomainSuffix });
      if (!uuid || !domain) return { ok: false, status: 409, message: "This app has no address to apply." };
      const { applyCoolifyServiceDomains, restartCoolifyService } = await import("@/lib/coolify");
      const applied = await applyCoolifyServiceDomains(uuid, domain);
      if (!applied.ok) {
        return {
          ok: false,
          status: applied.reason === "conflict" ? 409 : 502,
          message: applied.reason === "conflict"
            ? `${domain} is already used by another site, so it can't be applied here.`
            : `The address couldn't be applied yet. Try again in a minute.`,
          remedy: applied.reason === "conflict" ? null : remedy("apply_site_domain")
        };
      }
      const restart = await restartCoolifyService(uuid);
      return restart.ok
        ? { ok: true, status: 200, message: `${domain} applied and the site restarted. It answers there within a minute.` }
        : { ok: false, status: 502, message: `${domain} is saved, but the restart that makes it live didn't go through.`, remedy: remedy("restart_site", { target: "production" }) };
    }

    case "retry_staging_cleanup":
    case "retry_staging_provision": {
      const { POST } = await import("@/app/api/sites/[siteId]/staging/route");
      const enabling = action === "retry_staging_provision";
      const response = await POST(
        forwardedRequest(req, `${origin}/api/sites/${encodeURIComponent(routeSiteId)}/staging`, "POST", enabling ? { enabled: true } : { enabled: false, burnExisting: true }),
        { params: Promise.resolve({ siteId: routeSiteId }) }
      );
      return outcomeFrom(
        response,
        enabling ? "Staging setup started again." : "The old staging copy was removed. You can turn staging on now.",
        remedy(action)
      );
    }

    case "retry_staging_database": {
      const { ensureStagingDatabases } = await import("@/lib/staging-databases");
      const result = await ensureStagingDatabases(site.id);
      return { ok: result.ok, status: result.ok ? 200 : 409, message: result.message, remedy: result.ok ? null : remedy("retry_staging_database") };
    }

    case "retry_site_delete": {
      const { DELETE } = await import("@/app/api/sites/[siteId]/route");
      const response = await DELETE(
        forwardedRequest(req, `${origin}/api/sites/${encodeURIComponent(routeSiteId)}`, "DELETE", { deleteCoolifyResource: true }),
        { params: Promise.resolve({ siteId: routeSiteId }) }
      );
      const payload: any = await response.clone().json().catch(() => null);
      if (response.ok && payload?.ok !== false) return { ok: true, status: 200, message: "The app and its running site were deleted." };
      return { ok: false, status: response.status || 502, message: "The running site couldn't be deleted yet. Nothing was removed. Try again in a minute.", remedy: remedy("retry_site_delete") };
    }

    default:
      return { ok: false, status: 400, message: "This action isn't available for a site." };
  }
}
