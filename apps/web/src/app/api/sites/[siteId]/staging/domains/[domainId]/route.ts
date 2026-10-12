import { NextResponse } from "next/server";
import { removeStagingDomain } from "@/lib/staging-domains";
import { resolveStagingDomainAccess } from "@/lib/staging-domain-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string; domainId: string }> };

/** DELETE: detach in Coolify and fall back to the .mfts.link address. */
export async function DELETE(_request: Request, { params }: Params) {
  const { siteId, domainId } = await params;
  const access = await resolveStagingDomainAccess(siteId, { manage: true });
  if ("response" in access) return access.response;
  const result = await removeStagingDomain({ siteId: access.siteDbId, domainId, actorId: access.userId });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  return NextResponse.json({ ok: true, message: result.message });
}
