import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { getWordPressTelemetrySnapshot } from "@/lib/wordpress-telemetry";

type Params = { params: Promise<{ siteId: string }> };

/**
 * GET /api/sites/[siteId]/wordpress-telemetry
 * Read-only WordPress telemetry snapshot endpoint.
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  try {
    const workspace = await getSiteWorkspace(siteId, {
      userId: session.user.id,
      email: session.user.email
    });

    if (!workspace) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const snapshot = getWordPressTelemetrySnapshot({
      siteId: workspace.slug ?? workspace.id,
      isWordPress: workspace.siteType === "wordpress",
      hasCoolifyServiceUuid: Boolean(workspace.coolifyServiceUuid)
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("GET /api/sites/[siteId]/wordpress-telemetry error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}