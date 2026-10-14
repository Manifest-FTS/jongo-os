import { NextResponse } from "next/server";
import { installStateSecret, publicOrigin, requireOrgMember } from "@/lib/github-route-access";
import { signInstallState } from "@/lib/github-install-state";
import { buildAppManifest } from "@/lib/github-app-manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; sourceId: string }> };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * Step 1, "Register on GitHub" (Coolify's "Register Now"): posts the app
 * manifest to GitHub, on the source's organization or the person's account.
 */
export async function GET(request: Request, { params }: Params) {
  const { organizationId, sourceId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const origin = publicOrigin(request);
  const back = `${origin}/clients/${organizationId}/sources`;
  const { getDb } = await import("@/lib/db");
  const db: any = await getDb();
  const source = await db?.githubAppConfig.findUnique({ where: { id: sourceId } });
  if (!source || source.organizationId !== organizationId) return NextResponse.redirect(`${back}?github=not_found`);
  if (source.appId) return NextResponse.redirect(`${back}?github=already_registered`);
  const secret = installStateSecret();
  if (!secret) return NextResponse.redirect(`${back}?github=failed`);
  const state = signInstallState({ orgId: organizationId, userId: access.userId, sourceId }, secret);
  const manifest = buildAppManifest({ baseUrl: origin, name: source.name, public: false });
  const action = source.ownerLogin
    ? `https://github.com/organizations/${encodeURIComponent(source.ownerLogin)}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Registering on GitHub…</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#1f2a1f">
<p>Taking you to GitHub to register <strong>${escapeHtml(source.name)}</strong>…</p>
<form id="f" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><noscript><button type="submit">Continue to GitHub</button></noscript></form>
<script>document.getElementById("f").submit();</script>
</body></html>`;
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
