import { NextResponse } from "next/server";
import { installStateSecret, publicOrigin, requireOrgAdmin } from "@/lib/github-route-access";
import { signInstallState } from "@/lib/github-install-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/** GET: send the admin to GitHub to install the Jongo app, carrying a signed state. */
export async function GET(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgAdmin(organizationId);
  if ("response" in access) return access.response;
  const { getGithubApp } = await import("@/lib/github-app");
  const app = await getGithubApp();
  const back = `${publicOrigin(request)}/clients/${organizationId}/settings`;
  if (!app) return NextResponse.redirect(`${back}?github=not_ready`);
  const secret = installStateSecret();
  if (!secret) return NextResponse.redirect(`${back}?github=not_ready`);
  const state = signInstallState({ orgId: organizationId, userId: access.userId }, secret);
  return NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`);
}
