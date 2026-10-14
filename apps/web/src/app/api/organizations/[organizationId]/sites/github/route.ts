import { NextResponse } from "next/server";
import { requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/**
 * POST: create an app from one of this client's GitHub repos.
 * Body: { name, repo, branch, buildPack: "nixpacks"|"dockerfile", port, baseDirectory?, envVars?, temporaryDomainSlug?, temporaryDomainSuffix? }
 */
export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const body: any = await request.json().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim()) return NextResponse.json({ ok: false, message: "Give the app a name." }, { status: 400 });

  const { createSiteFromGithub, createSiteFromPublicRepo } = await import("@/lib/github-deploys");
  const common = {
    orgId: organizationId,
    userId: access.userId,
    name: body.name,
    branch: String(body.branch ?? ""),
    buildPack: (body.buildPack === "dockerfile" ? "dockerfile" : "nixpacks") as "dockerfile" | "nixpacks",
    port: Number(body.port ?? 3000),
    baseDirectory: typeof body.baseDirectory === "string" ? body.baseDirectory : "",
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((row: any) => typeof row?.key === "string").map((row: any) => ({ key: String(row.key), value: String(row.value ?? "") }))
      : [],
    temporaryDomainSlug: typeof body.temporaryDomainSlug === "string" ? body.temporaryDomainSlug : null,
    temporaryDomainSuffix: typeof body.temporaryDomainSuffix === "string" ? body.temporaryDomainSuffix : null
  };
  const result = await (body.mode === "public"
    ? createSiteFromPublicRepo({ ...common, repoUrl: String(body.repoUrl ?? "") })
    : createSiteFromGithub({ ...common, repoFullName: String(body.repo ?? ""), sourceId: typeof body.source === "string" ? body.source : null })
  ).catch((error): Awaited<ReturnType<typeof createSiteFromGithub>> => {
    console.error("[github] create from repo failed", error);
    return { ok: false, status: 502, message: "Couldn't reach GitHub or the server just now. Nothing was created; try again." };
  });
  return NextResponse.json({ ok: result.ok, message: result.message, ...(result.value ?? {}) }, { status: result.status });
}
