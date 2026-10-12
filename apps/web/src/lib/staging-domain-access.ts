import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

/**
 * Who may see and change a site's custom staging domains: anyone who can open
 * the site may see them; changing them needs canEditDomains (client admins),
 * the same bar as production domains.
 */
export async function resolveStagingDomainAccess(
  siteId: string,
  options: { manage: boolean }
): Promise<{ siteDbId: string; userId: string; canManage: boolean } | { response: NextResponse }> {
  const session = await auth();
  if (!session?.user?.id) return { response: NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 }) };

  const { getSiteWorkspace } = await import("@/lib/repositories");
  const { resolveSitePermissionSnapshot } = await import("@/lib/permissions");
  const viewer = { userId: session.user.id, email: session.user.email };
  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace || !/^[0-9a-f-]{36}$/i.test(workspace.id)) {
    return { response: NextResponse.json({ ok: false, message: "Not found." }, { status: 404 }) };
  }
  const permissions = await resolveSitePermissionSnapshot({ siteId, workspace, viewer });
  if (options.manage && !permissions.canEditDomains) {
    return { response: NextResponse.json({ ok: false, message: "Only the client's admins can change staging domains." }, { status: 403 }) };
  }
  return { siteDbId: workspace.id, userId: session.user.id, canManage: permissions.canEditDomains };
}
