import { NextResponse } from "next/server";
import { requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/** GET ?q=: repos shared with this client's install (names only, no tokens). */
export async function GET(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  // "Not connected yet" is a normal state of the picker, not an error: answer
  // 200 with what's missing so the form can say what to do next.
  const { getOrgInstallation } = await import("@/lib/github-installations");
  const install = await getOrgInstallation(organizationId);
  if (!install) return NextResponse.json({ ok: true, state: "not_connected", repos: [] });
  if (install.status === "suspended") return NextResponse.json({ ok: true, state: "suspended", repos: [] });
  if (!install.coolifySourceUuid) return NextResponse.json({ ok: true, state: "finishing_setup", repos: [] });

  const { reposForOrg } = await import("@/lib/github-deploys");
  const result = await reposForOrg(organizationId).catch(() => ({ ok: false as const, status: 502, message: "Couldn't reach GitHub just now. Try again." }));
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const repos = result.repos.filter((repo) => !q || repo.fullName.toLowerCase().includes(q)).slice(0, 200);
  return NextResponse.json({ ok: true, state: "ready", repos });
}
