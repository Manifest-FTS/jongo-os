import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { canUseGithubForOrg, installStateSecret, publicOrigin, requirePlatformAdmin } from "@/lib/github-route-access";
import { signInstallState, verifyInstallState } from "@/lib/github-install-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub returns here after creating a Jongo GitHub App from the manifest.
 * The one-time code is exchanged for the app's credentials (stored encrypted,
 * never shown). For a client's own app the flow continues straight to
 * installing it, so connecting GitHub stays one flow for the client.
 */
export async function GET(request: Request) {
  const origin = publicOrigin(request);
  const url = new URL(request.url);
  const state = verifyInstallState(url.searchParams.get("state"), installStateSecret());
  const session = await auth();
  if (!state.ok || !session?.user?.id || session.user.id !== state.payload.userId) {
    return NextResponse.redirect(`${origin}/dashboard?github=link_expired`);
  }
  const shared = state.payload.orgId === "platform";
  const back = shared ? `${origin}/admin/github` : `${origin}/clients/${state.payload.orgId}`;
  if (shared ? "response" in (await requirePlatformAdmin()) : !(await canUseGithubForOrg(state.payload.orgId, session.user.id, session.user.email))) {
    return NextResponse.redirect(`${back}?github=not_allowed`);
  }
  const code = url.searchParams.get("code");
  if (!code) return NextResponse.redirect(`${back}?github=failed`);

  try {
    const { convertManifestCode } = await import("@/lib/github-app");
    const { saveGithubApp } = await import("@/lib/github-installations");
    const conversion = await convertManifestCode(code);
    const saved = await saveGithubApp(conversion, session.user.id, shared ? null : state.payload.orgId);
    if (shared || !saved.app) return NextResponse.redirect(`${back}?github=${saved.ok ? "created" : "failed"}`);
    const next = signInstallState({ orgId: state.payload.orgId, userId: session.user.id }, installStateSecret());
    return NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(saved.app.slug)}/installations/new?state=${encodeURIComponent(next)}`);
  } catch (error) {
    console.error("[github] manifest conversion failed", error);
    return NextResponse.redirect(`${back}?github=failed`);
  }
}

/** POST { action: "resync_key" }: upload the shared app's key again (platform operators). */
export async function POST(request: Request) {
  const access = await requirePlatformAdmin();
  if ("response" in access) return access.response;
  const body: any = await request.json().catch(() => null);
  if (body?.action !== "resync_key") return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  const { getGithubApp } = await import("@/lib/github-app");
  const { ensureHostingKey } = await import("@/lib/github-installations");
  const result = await ensureHostingKey(await getGithubApp());
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
