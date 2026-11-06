import { NextResponse } from "next/server";
import { requireOrgMember } from "@/lib/github-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string }> };

/**
 * POST: look inside a repo and suggest a framework preset (build type, port,
 * commands, output folder), like Vercel's import screen.
 * Body: { mode: "public", repoUrl, branch?, baseDirectory? }
 *     | { mode: "private", source, repo, branch, baseDirectory? }
 */
export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrgMember(organizationId);
  if ("response" in access) return access.response;

  // Each call reaches out to a Git host; keep it to what a person typing needs.
  const { hitRateLimit, tooManyAttemptsMessage, AUTH_RATE_LIMITS } = await import("@/lib/auth-rate-limit");
  const limited = await hitRateLimit(AUTH_RATE_LIMITS.repoInspectPerUser, access.userId);
  if (!limited.allowed) {
    return NextResponse.json({ ok: false, message: tooManyAttemptsMessage(limited.retryAfterSeconds) }, { status: 429 });
  }

  const body: any = await request.json().catch(() => null);
  const branch = typeof body?.branch === "string" ? body.branch : "";
  const baseDirectory = typeof body?.baseDirectory === "string" ? body.baseDirectory : "";
  const { inspectGithubRepo, inspectPublicRepo } = await import("@/lib/repo-inspect");

  let result;
  if (body?.mode === "public") {
    result = await inspectPublicRepo({ repoUrl: String(body.repoUrl ?? ""), branch, baseDirectory });
  } else {
    const { getOrgInstallation } = await import("@/lib/github-installations");
    const { assertInstallUsable } = await import("@/lib/github-access");
    const install = await getOrgInstallation(organizationId, typeof body?.source === "string" ? body.source : null);
    const usable = assertInstallUsable(install, organizationId);
    if (!usable.ok) return NextResponse.json({ ok: false, message: usable.message }, { status: usable.status });
    const repo = String(body?.repo ?? "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return NextResponse.json({ ok: false, message: "Choose a repository." }, { status: 400 });
    result = await inspectGithubRepo({ installationId: Number(install!.installationId), fullName: repo, branch, baseDirectory });
  }

  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: 422 });
  return NextResponse.json({
    ok: true,
    framework: result.detection.preset,
    reason: result.detection.reason,
    defaultBranch: result.defaultBranch
  });
}
