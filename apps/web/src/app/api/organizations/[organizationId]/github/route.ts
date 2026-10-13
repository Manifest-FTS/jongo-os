import { NextResponse } from "next/server";
import { requireOrgAdmin } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/** GET: this client's GitHub connection (no secrets, no tokens). */
export async function GET(_request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgAdmin(organizationId);
  if ("response" in access) return access.response;
  const { getGithubApp } = await import("@/lib/github-app");
  const { getOrgInstallation, installationSettingsUrl } = await import("@/lib/github-installations");
  const app = await getGithubApp().catch(() => null);
  const install = await getOrgInstallation(organizationId);
  const { isPlatformAdminEmail } = await import("@/lib/permissions");
  return NextResponse.json({
    ok: true,
    appReady: Boolean(app),
    canSetUpApp: await isPlatformAdminEmail(access.email),
    installation: install
      ? {
          account: install.accountLogin,
          accountType: install.accountType,
          status: install.status,
          repositorySelection: install.repositorySelection,
          ready: Boolean(install.coolifySourceUuid),
          lastError: install.lastError ? "Setup isn't finished yet." : null,
          manageUrl: installationSettingsUrl(install)
        }
      : null
  });
}

/** POST { action: "finish_setup" }: retry creating the hosting source now. */
export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgAdmin(organizationId);
  if ("response" in access) return access.response;
  const body: any = await request.json().catch(() => null);
  if (body?.action !== "finish_setup") return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  const { getOrgInstallation, ensureHostingSource } = await import("@/lib/github-installations");
  const install = await getOrgInstallation(organizationId);
  if (!install) return NextResponse.json({ ok: false, message: "GitHub isn't connected." }, { status: 404 });
  const result = await ensureHostingSource(install);
  return NextResponse.json({ ok: result.ok, message: result.ok ? "Setup finished." : result.message }, { status: result.ok ? 200 : 502 });
}

/** DELETE: disconnect GitHub from this client. */
export async function DELETE(_request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgAdmin(organizationId);
  if ("response" in access) return access.response;
  const { disconnectInstallation } = await import("@/lib/github-installations");
  const result = await disconnectInstallation(organizationId, access.userId);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
