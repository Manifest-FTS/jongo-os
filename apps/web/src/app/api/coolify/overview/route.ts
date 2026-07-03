import { NextResponse } from "next/server";
import { getCoolifyOverview } from "../../../../lib/coolify";
import { auth } from "@/lib/auth.config";

export async function GET(request: Request) {
  const session = await auth();

  const syncToken = process.env.OWNERSHIP_SYNC_TOKEN;
  const authHeader = request.headers.get("authorization") ?? undefined;
  const providedToken = authHeader?.replace(/^Bearer\s+/i, "").trim();
  const tokenAuthorized = Boolean(syncToken && providedToken && providedToken === syncToken);
  const sessionEmail = session?.user?.email?.trim().toLowerCase() ?? "";
  const bootstrapAdmin = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const adminSession = Boolean(session?.user?.id && bootstrapAdmin && sessionEmail === bootstrapAdmin);

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
