import { NextResponse } from "next/server";
import { requireOrgAdmin } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/** GET ?repo=owner/name: branches of a repo shared with this client's install. */
export async function GET(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgAdmin(organizationId);
  if ("response" in access) return access.response;
  const repo = (new URL(request.url).searchParams.get("repo") ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return NextResponse.json({ ok: false, message: "Choose a repository." }, { status: 400 });
  const { branchesForOrg } = await import("@/lib/github-deploys");
  const result = await branchesForOrg(organizationId, repo).catch(() => ({ ok: false as const, status: 502, message: "Couldn't reach GitHub just now. Try again." }));
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  return NextResponse.json({ ok: true, branches: result.branches });
}
