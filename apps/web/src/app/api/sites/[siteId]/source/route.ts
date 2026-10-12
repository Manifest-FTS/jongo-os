import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

async function access(siteId: string, manage: boolean) {
  const session = await auth();
  if (!session?.user?.id) return { response: NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 }) };
  const { getSiteWorkspace } = await import("@/lib/repositories");
  const { resolveSitePermissionSnapshot } = await import("@/lib/permissions");
  const viewer = { userId: session.user.id, email: session.user.email };
  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace || !/^[0-9a-f-]{36}$/i.test(workspace.id)) return { response: NextResponse.json({ ok: false, message: "Not found." }, { status: 404 }) };
  const permissions = await resolveSitePermissionSnapshot({ siteId, workspace, viewer });
  if (manage && !permissions.isAdmin && !permissions.isPlatformAdmin) {
    return { response: NextResponse.json({ ok: false, message: "Only the client's admins can change where this app deploys from." }, { status: 403 }) };
  }
  return { siteDbId: workspace.id, userId: session.user.id, canDeploy: permissions.canPromoteStaging };
}

/** PATCH { repo?, branch?, stagingBranch?, autoDeploy? } (client admins). */
export async function PATCH(request: Request, { params }: Params) {
  const { siteId } = await params;
  const ctx = await access(siteId, true);
  if ("response" in ctx) return ctx.response;
  const body: any = await request.json().catch(() => ({}));
  const { updateSiteSource } = await import("@/lib/github-deploys");
  const result = await updateSiteSource({
    siteId: ctx.siteDbId,
    actorId: ctx.userId,
    repoFullName: typeof body.repo === "string" && body.repo ? body.repo : undefined,
    branch: typeof body.branch === "string" && body.branch ? body.branch : undefined,
    stagingBranch: body.stagingBranch === null || typeof body.stagingBranch === "string" ? body.stagingBranch : undefined,
    autoDeploy: typeof body.autoDeploy === "boolean" ? body.autoDeploy : undefined
  }).catch(() => ({ ok: false, status: 502, message: "Couldn't reach GitHub or the server just now. Nothing changed." }));
  return NextResponse.json({ ok: result.ok, message: result.message }, { status: result.status });
}

/** POST { action: "deploy" }: deploy now (the pending commit, when there is one). */
export async function POST(request: Request, { params }: Params) {
  const { siteId } = await params;
  const ctx = await access(siteId, false);
  if ("response" in ctx) return ctx.response;
  if (!ctx.canDeploy) return NextResponse.json({ ok: false, message: "You can't deploy this app." }, { status: 403 });
  const body: any = await request.json().catch(() => ({}));
  if (body?.action !== "deploy") return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  const { deployNow } = await import("@/lib/github-deploys");
  const result = await deployNow(ctx.siteDbId, ctx.userId);
  return NextResponse.json({ ok: result.ok, message: result.message }, { status: result.status });
}
