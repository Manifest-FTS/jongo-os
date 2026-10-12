import { NextResponse } from "next/server";
import { addStagingDomain, listStagingDomains } from "@/lib/staging-domains";
import { resolveStagingDomainAccess } from "@/lib/staging-domain-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

/** GET: the site's custom staging domains, the fallback and which one is the link. */
export async function GET(_request: Request, { params }: Params) {
  const access = await resolveStagingDomainAccess((await params).siteId, { manage: false });
  if ("response" in access) return access.response;
  const result = await listStagingDomains(access.siteDbId);
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  return NextResponse.json({ ok: true, canManage: access.canManage, ...result.value });
}

/** POST { hostname }: claim a hostname; it stays pending until DNS is verified. */
export async function POST(request: Request, { params }: Params) {
  const access = await resolveStagingDomainAccess((await params).siteId, { manage: true });
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { hostname?: unknown };
  const result = await addStagingDomain({ siteId: access.siteDbId, hostname: String(body.hostname ?? ""), actorId: access.userId });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  return NextResponse.json({ ok: true, message: result.message, domain: result.value });
}
