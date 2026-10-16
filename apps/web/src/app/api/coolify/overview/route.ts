import { NextResponse } from "next/server";
import { getCoolifyOverview } from "../../../../lib/coolify";
import { auth } from "@/lib/auth.config";
import { isPlatformAdminUser } from "@/lib/rbac";

export async function GET(request: Request) {
  const session = await auth();

  const syncToken = process.env.OWNERSHIP_SYNC_TOKEN;
  const authHeader = request.headers.get("authorization") ?? undefined;
  const providedToken = authHeader?.replace(/^Bearer\s+/i, "").trim();
  const tokenAuthorized = Boolean(syncToken && providedToken && providedToken === syncToken);
  const adminSession = await isPlatformAdminUser(session?.user?.id);

  if (!adminSession && !tokenAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const overview = await getCoolifyOverview();

  return NextResponse.json(overview, {
    status: 200,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
