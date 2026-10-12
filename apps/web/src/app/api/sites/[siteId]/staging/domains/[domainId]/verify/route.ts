import { NextResponse } from "next/server";
import { verifyStagingDomain } from "@/lib/staging-domains";
import { resolveStagingDomainAccess } from "@/lib/staging-domain-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string; domainId: string }> };

/**
 * POST: check DNS and, when it points at Jongo, attach the domain. On an
 * attached domain it re-checks DNS and the certificate.
 *
 * 422 for "DNS is not right yet" (a normal step, not an error), 429 for
 * "checked a moment ago".
 */
export async function POST(_request: Request, { params }: Params) {
  const { siteId, domainId } = await params;
  const access = await resolveStagingDomainAccess(siteId, { manage: true });
  if ("response" in access) return access.response;
  const result = await verifyStagingDomain({ siteId: access.siteDbId, domainId, actorId: access.userId });
  return NextResponse.json({ ok: result.ok, message: result.message }, { status: result.ok ? 200 : result.status });
}
