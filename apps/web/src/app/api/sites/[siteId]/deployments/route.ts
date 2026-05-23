import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function normalizeLimit(raw: string | null): number {
  const parsed = Number(raw ?? 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }

  return Math.min(Math.floor(parsed), 50);
}

export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;
  const url = new URL(req.url);
  const limit = normalizeLimit(url.searchParams.get("limit"));

  const viewer = {
    userId: session.user.id,
    email: session.user.email ?? undefined
  };

  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const deployments = (await listSiteDeployments(siteId, viewer)).slice(0, limit);
  const latestProduction = deployments.find((item) => item.environment === "production") ?? null;
  const inProgressProduction = deployments.find(
    (item) => item.environment === "production" && item.status === "in_progress"
  ) ?? null;

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    deployments,
    latestProduction,
    inProgressProduction
  });
}
