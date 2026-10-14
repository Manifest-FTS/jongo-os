import { NextResponse } from "next/server";
import { installStateSecret, publicOrigin, requireOrgMember } from "@/lib/github-route-access";
import { signInstallState } from "@/lib/github-install-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; sourceId: string }> };

/** Step 2, "Install repositories" (Coolify's "Install Repositories on GitHub"). */
export async function GET(request: Request, { params }: Params) {
  const { organizationId, sourceId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const back = `${publicOrigin(request)}/clients/${organizationId}/sources`;
  const { getGithubApp } = await import("@/lib/github-app");
  const app = await getGithubApp({ id: sourceId });
  if (!app || app.organizationId !== organizationId || !app.slug) return NextResponse.redirect(`${back}?github=register_first`);
  const state = signInstallState({ orgId: organizationId, userId: access.userId, sourceId }, installStateSecret());
  return NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`);
}
