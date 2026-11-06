import { NextResponse } from "next/server";
import { resolveStagingDomainAccess } from "@/lib/staging-domain-access";
import { listProductionDomains, setPrimaryProductionDomain } from "@/lib/production-domains";
import { progressResponse, wantsProgress } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

/** GET: the live site's addresses, which one is primary, and its DNS health. */
export async function GET(_request: Request, { params }: Params) {
  // Same rule as staging domains: anyone on the site may look; client admins change.
  const access = await resolveStagingDomainAccess((await params).siteId, { manage: false });
  if ("response" in access) return access.response;
  const result = await listProductionDomains(access.siteDbId);
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  return NextResponse.json({ ok: true, canManage: access.canManage, ...result.value });
}

/**
 * POST { primary }: make that address the main one. Takes up to a few
 * minutes on a large WordPress site (the database rewrite), so it streams
 * its steps when asked (Accept: application/x-ndjson).
 */
export async function POST(request: Request, { params }: Params) {
  const access = await resolveStagingDomainAccess((await params).siteId, { manage: true });
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { primary?: unknown };
  const host = typeof body.primary === "string" ? body.primary : "";
  if (!host.trim()) return NextResponse.json({ ok: false, message: "Choose an address." }, { status: 400 });

  const run = async () => {
    // One change of main address per site at a time (two tabs, a double click).
    const { createOrJoinActiveOperation, failOperation, startOperation, succeedOperation } = await import("@/lib/operations");
    const { db } = await import("@/lib/db");
    const site = await db.site.findUnique({ where: { id: access.siteDbId }, select: { organizationId: true } });
    const { operation, created } = await createOrJoinActiveOperation(
      { kind: "site.domain.primary", organizationId: site?.organizationId ?? null, actorId: access.userId, resourceType: "site", resourceId: access.siteDbId, input: { primary: host } },
      { lockKey: `site.domain.primary:${access.siteDbId}` }
    );
    if (!created) {
      const startedAt = new Date((operation.startedAt ?? operation.createdAt) as Date).getTime();
      if (Date.now() - startedAt < 15 * 60 * 1000) {
        return NextResponse.json({ ok: false, message: "The main address is already being changed. Wait for it to finish." }, { status: 409 });
      }
      await failOperation(operation.id, "Stopped before it finished.");
      return NextResponse.json({ ok: false, message: "A previous change didn't finish. Try again now." }, { status: 409 });
    }
    await startOperation(operation.id);
    try {
      const result = await setPrimaryProductionDomain({ siteId: access.siteDbId, host, actorId: access.userId });
      if (result.ok) await succeedOperation(operation.id, { primary: host });
      else await failOperation(operation.id, result.message);
      return NextResponse.json(result.ok ? { ok: true, message: result.message } : { ok: false, message: result.message }, { status: result.ok ? 200 : result.status });
    } catch (error) {
      await failOperation(operation.id, "The change didn't finish.").catch(() => false);
      throw error;
    }
  };
  return wantsProgress(request) ? progressResponse(run) : run();
}
