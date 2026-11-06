import { NextResponse } from "next/server";
import { requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/** GET: this client's deploy keys (public halves only). */
export async function GET(_request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const { db } = await import("@/lib/db");
  const keys = await db.gitDeployKey.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, publicKey: true, createdAt: true }
  });
  return NextResponse.json({ ok: true, keys });
}

/** POST: make a new deploy key. Body: { label? } */
export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const { hitRateLimit, tooManyAttemptsMessage, AUTH_RATE_LIMITS } = await import("@/lib/auth-rate-limit");
  const limited = await hitRateLimit(AUTH_RATE_LIMITS.deployKeyPerOrg, organizationId);
  if (!limited.allowed) return NextResponse.json({ ok: false, message: tooManyAttemptsMessage(limited.retryAfterSeconds) }, { status: 429 });

  const body: any = await request.json().catch(() => ({}));
  const { createDeployKey } = await import("@/lib/deploy-keys");
  const result = await createDeployKey({
    organizationId,
    actorId: access.userId,
    label: typeof body?.label === "string" ? body.label : undefined
  });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id, publicKey: result.publicKey }, { status: 201 });
}
