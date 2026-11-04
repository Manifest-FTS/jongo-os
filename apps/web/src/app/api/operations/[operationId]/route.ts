import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { publicDeployView, SITE_DEPLOY_KIND } from "@/lib/deploy-operation";
import { getOperation } from "@/lib/operations";
import { resolveSiteAccess } from "@/lib/tenant-route-access";

export const runtime = "nodejs";

/**
 * GET /api/operations/{id} — progress of a background task the caller may see.
 * Access follows the resource the task is about; anything else is "not found",
 * so ids from other organizations reveal nothing.
 */
export async function GET(_req: Request, context: { params: Promise<{ operationId: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const { operationId } = await context.params;
  const operation = await getOperation(operationId);
  const notFound = NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!operation || operation.resourceType !== "site" || !operation.resourceId) return notFound;

  const access = await resolveSiteAccess(operation.resourceId, userId);
  if (!access || access.site.id !== operation.resourceId) return notFound;

  if (operation.kind === SITE_DEPLOY_KIND) {
    return NextResponse.json({ operation: publicDeployView(operation) });
  }
  return notFound;
}
