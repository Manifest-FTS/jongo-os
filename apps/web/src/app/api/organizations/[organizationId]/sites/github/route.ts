import { NextResponse } from "next/server";
import { requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/**
 * POST: create an app from a repository, Vercel-style.
 * Body: { mode: "private" | "public" | "deploykey", name, branch, buildPack, port,
 *         baseDirectory?, build?: { installCommand, buildCommand, startCommand, publishDirectory, isStatic, isSpa },
 *         envVars?, temporaryDomainSlug?, temporaryDomainSuffix? }
 *   private:   { source, repo }       a GitHub repo through the client's GitHub connection
 *   public:    { repoUrl }            a public GitHub, GitLab, Bitbucket or Codeberg repo
 *   deploykey: { sshUrl, deployKeyId } a private repo on any Git host
 */
export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;
  const body: any = await request.json().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim()) return NextResponse.json({ ok: false, message: "Give the app a name." }, { status: 400 });

  const { createSiteFromGithub, createSiteFromPublicRepo, createSiteFromDeployKey } = await import("@/lib/github-deploys");
  const common = {
    orgId: organizationId,
    userId: access.userId,
    name: body.name,
    branch: String(body.branch ?? ""),
    buildPack: (body.buildPack === "dockerfile" || body.buildPack === "static" ? body.buildPack : "nixpacks") as "dockerfile" | "nixpacks" | "static",
    port: Number(body.port ?? 3000),
    baseDirectory: typeof body.baseDirectory === "string" ? body.baseDirectory : "",
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((row: any) => typeof row?.key === "string").map((row: any) => ({ key: String(row.key), value: String(row.value ?? "") }))
      : [],
    temporaryDomainSlug: typeof body.temporaryDomainSlug === "string" ? body.temporaryDomainSlug : null,
    temporaryDomainSuffix: typeof body.temporaryDomainSuffix === "string" ? body.temporaryDomainSuffix : null,
    build: readBuildSettings(body.build)
  };
  const result = await (body.mode === "public"
    ? createSiteFromPublicRepo({ ...common, repoUrl: String(body.repoUrl ?? "") })
    : body.mode === "deploykey"
      ? createSiteFromDeployKey({ ...common, sshUrl: String(body.sshUrl ?? ""), deployKeyId: String(body.deployKeyId ?? "") })
      : createSiteFromGithub({ ...common, repoFullName: String(body.repo ?? ""), sourceId: typeof body.source === "string" ? body.source : null })
  ).catch((error): Awaited<ReturnType<typeof createSiteFromDeployKey>> => {
    console.error("[github] create from repo failed", error);
    return { ok: false, status: 502, message: "Couldn't reach GitHub or the server just now. Nothing was created; try again." };
  });
  return NextResponse.json({ ok: result.ok, message: result.message, ...(result.value ?? {}) }, { status: result.status });
}

function readBuildSettings(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  return {
    installCommand: text("installCommand"),
    buildCommand: text("buildCommand"),
    startCommand: text("startCommand"),
    publishDirectory: text("publishDirectory"),
    isStatic: raw.isStatic === true,
    isSpa: raw.isSpa === true
  };
}
