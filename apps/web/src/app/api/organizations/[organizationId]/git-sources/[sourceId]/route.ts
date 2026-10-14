import { NextResponse } from "next/server";
import { requireOrgAdmin, requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; sourceId: string }> };

/** PATCH: Manual installation (an existing GitHub App's credentials). */
export async function PATCH(request: Request, { params }: Params) {
  const { organizationId, sourceId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const body: any = await request.json().catch(() => ({}));
  const { saveManualGitSource } = await import("@/lib/github-installations");
  const result = await saveManualGitSource(organizationId, sourceId, access.userId, {
    appId: Number(body?.appId),
    installationId: Number(body?.installationId),
    clientId: String(body?.clientId ?? ""),
    clientSecret: String(body?.clientSecret ?? ""),
    webhookSecret: String(body?.webhookSecret ?? ""),
    privateKey: String(body?.privateKey ?? "")
  }).catch((error) => {
    console.error("[git-sources] manual save failed", error);
    return { ok: false, status: 502, message: "Couldn't reach GitHub just now. Nothing was saved." };
  });
  return NextResponse.json(result, { status: result.status });
}

/** DELETE: remove a Git source (client admins). */
export async function DELETE(_request: Request, { params }: Params) {
  const { organizationId, sourceId } = await params;
  const access = await requireOrgAdmin(organizationId);
  if ("response" in access) return access.response;
  const { deleteGitSource } = await import("@/lib/github-installations");
  const result = await deleteGitSource(organizationId, sourceId, access.userId);
  return NextResponse.json(result, { status: result.status });
}
