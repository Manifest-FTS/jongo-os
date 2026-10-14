import { NextResponse } from "next/server";
import { requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/** GET: this client's Git sources (no secrets). */
export async function GET(_request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const { listGitSources } = await import("@/lib/github-installations");
  return NextResponse.json({ ok: true, sources: await listGitSources(organizationId) });
}

/** POST { name, ownerLogin? }: Add GitHub App (a draft, registered next). */
export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const body: any = await request.json().catch(() => ({}));
  const { createGitSource } = await import("@/lib/github-installations");
  const result = await createGitSource(organizationId, access.userId, { name: String(body?.name ?? ""), ownerLogin: typeof body?.ownerLogin === "string" ? body.ownerLogin : null });
  return NextResponse.json(result, { status: result.status });
}
