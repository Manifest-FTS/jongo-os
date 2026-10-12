import { NextResponse } from "next/server";
import { installStateSecret, publicOrigin, requirePlatformAdmin } from "@/lib/github-route-access";
import { verifyInstallState } from "@/lib/github-install-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub returns here once the platform admin approves the app manifest. The
 * one-time code is exchanged for the app's credentials, which are stored
 * encrypted and never shown again.
 */
export async function GET(request: Request) {
  const back = `${publicOrigin(request)}/admin/github`;
  const access = await requirePlatformAdmin();
  if ("response" in access) return NextResponse.redirect(`${back}?result=not_admin`);

  const url = new URL(request.url);
  const state = verifyInstallState(url.searchParams.get("state"), installStateSecret());
  if (!state.ok || state.payload.orgId !== "platform" || state.payload.userId !== access.userId) {
    return NextResponse.redirect(`${back}?result=link_expired`);
  }
  const code = url.searchParams.get("code");
  if (!code) return NextResponse.redirect(`${back}?result=missing_code`);

  try {
    const { convertManifestCode } = await import("@/lib/github-app");
    const { saveGithubApp } = await import("@/lib/github-installations");
    const conversion = await convertManifestCode(code);
    const saved = await saveGithubApp(conversion, access.userId);
    return NextResponse.redirect(`${back}?result=${saved.ok ? "created" : "exists"}`);
  } catch (error) {
    console.error("[github] manifest conversion failed", error);
    return NextResponse.redirect(`${back}?result=failed`);
  }
}

/** POST { action: "resync_key" }: upload the app's key to the hosting server again. */
export async function POST(request: Request) {
  const access = await requirePlatformAdmin();
  if ("response" in access) return access.response;
  const body: any = await request.json().catch(() => null);
  if (body?.action !== "resync_key") return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  const { ensureHostingKey } = await import("@/lib/github-installations");
  const result = await ensureHostingKey();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
