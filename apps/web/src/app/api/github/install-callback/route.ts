import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { canUseGithubForOrg, installStateSecret, publicOrigin } from "@/lib/github-route-access";
import { verifyInstallState } from "@/lib/github-install-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub sends the admin back here after installing (or updating) the app.
 * The state proves which client and user started it; the installation is then
 * confirmed with GitHub before anything is saved.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  const installationId = Number(url.searchParams.get("installation_id"));
  const setupAction = url.searchParams.get("setup_action");
  const state = verifyInstallState(url.searchParams.get("state"), installStateSecret());

  if (!state.ok) {
    // An update started on GitHub (no state): the webhook keeps Jongo in sync.
    return NextResponse.redirect(`${origin}/dashboard?github=${setupAction === "update" ? "updated" : "link_expired"}`);
  }
  // The Apps page: every member of the client team can see it (settings is admin-only).
  const back = `${origin}/clients/${state.payload.orgId}/apps`;
  const session = await auth();
  if (!session?.user?.id || session.user.id !== state.payload.userId) return NextResponse.redirect(`${back}?github=wrong_user`);

  if (!(await canUseGithubForOrg(state.payload.orgId, session.user.id, session.user.email))) {
    return NextResponse.redirect(`${back}?github=not_allowed`);
  }
  if (setupAction === "request") return NextResponse.redirect(`${back}?github=requested`);
  if (!Number.isFinite(installationId) || installationId <= 0) return NextResponse.redirect(`${back}?github=missing_install`);

  const { connectInstallation } = await import("@/lib/github-installations");
  const result = await connectInstallation({ orgId: state.payload.orgId, userId: session.user.id, installationId }).catch((error) => {
    console.error("[github] connect failed", error);
    return { ok: false, status: 502, message: "" };
  });
  return NextResponse.redirect(`${back}?github=${result.ok ? "connected" : result.status === 409 ? "in_use" : "failed"}`);
}
