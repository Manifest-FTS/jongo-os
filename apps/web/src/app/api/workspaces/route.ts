import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { listWorkspaceOptions, WorkspaceAuthenticationError, WorkspaceQueryError } from "@/lib/workspace-switcher";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const params = new URL(request.url).searchParams;
    const limit = params.has("limit") ? Number(params.get("limit")) : undefined;
    const page = await listWorkspaceOptions(session.user.id, {
      search: params.get("search") ?? "", cursor: params.get("cursor"), limit
    });
    return NextResponse.json(page, { headers });
  } catch (error) {
    const status = error instanceof WorkspaceAuthenticationError ? 401 : error instanceof WorkspaceQueryError ? 400 : 503;
    const message = status === 401 ? "Unauthorized" : status === 400 ? "Invalid workspace query." : "Workspaces are temporarily unavailable.";
    return NextResponse.json({ error: message }, { status, headers });
  }
}