import { NextResponse } from "next/server";
import { publicOrigin, requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/** Connect GitHub now lives on the client's Git sources page (Coolify's Sources). */
export async function GET(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  return NextResponse.redirect(`${publicOrigin(request)}/clients/${organizationId}/sources`);
}
