import { NextResponse } from "next/server";
import { installStateSecret, publicOrigin, requireOrgMember } from "@/lib/github-route-access";
import { signInstallState } from "@/lib/github-install-state";
import { buildAppManifest, clientAppName } from "@/lib/github-app-manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * GET ?owner=<github-org>: Connect GitHub, for anyone on the client's team.
 * The client already has a Jongo GitHub App → straight to its install page.
 * Otherwise GitHub first creates one on the client's own account (or the
 * GitHub organization in ?owner), then sends them on to install it — one flow.
 */
export async function GET(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const origin = publicOrigin(request);
  const back = `${origin}/clients/${organizationId}`;
  const secret = installStateSecret();
  if (!secret) return NextResponse.redirect(`${back}?github=failed`);
  const state = signInstallState({ orgId: organizationId, userId: access.userId }, secret);

  const { appForOrganization } = await import("@/lib/github-app");
  const app = await appForOrganization(organizationId);
  if (app) {
    return NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`);
  }

  const { getDb } = await import("@/lib/db");
  const db: any = await getDb();
  const org = await db?.organization.findUnique({ where: { id: organizationId }, select: { slug: true } });
  const owner = (new URL(request.url).searchParams.get("owner") ?? "").trim();
  if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) return NextResponse.redirect(`${back}?github=bad_owner`);
  const manifest = buildAppManifest({ baseUrl: origin, name: clientAppName(org?.slug ?? "client", organizationId), public: false });
  const action = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;

  // GitHub's manifest flow needs a form POST; this page submits itself.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connecting GitHub…</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#1f2a1f">
<p>Taking you to GitHub to connect your account…</p>
<form id="f" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><noscript><button type="submit">Continue to GitHub</button></noscript></form>
<script>document.getElementById("f").submit();</script>
</body></html>`;
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
