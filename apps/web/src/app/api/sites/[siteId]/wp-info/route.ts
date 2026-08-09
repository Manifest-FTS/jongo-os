import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

function resolveScriptPath(name: string): string | null {
  const cwd = process.cwd();
  return [
    path.join(cwd, "scripts", name),
    path.join(cwd, "..", "scripts", name),
    path.join(cwd, "..", "..", "scripts", name)
  ].find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Live runtime facts for a WordPress site: WP version, PHP version, database
 * name and table prefix.
 *
 * GET, and read-only all the way down — the script it runs starts nothing and
 * writes nothing. Gated on workspace access alone rather than a management
 * permission, because seeing which PHP version your site runs is not a
 * privileged action.
 *
 * Every field may be null. A stock image has no wp-cli and a stopped database
 * answers nothing, so a partial answer is the normal case; the UI shows blanks
 * rather than inventing defaults.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { siteId } = await params;
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    const workspace = await getSiteWorkspace(siteId, {
      userId: session.user.id,
      email: session.user.email
    });
    if (!workspace) {
      return NextResponse.json({ ok: false, message: "Not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("target") === "staging" ? "staging" : "production";

    let resourceUuid = workspace.coolifyServiceUuid?.trim();
    if (!resourceUuid) {
      return NextResponse.json({ ok: false, message: "This app is not linked to a Coolify resource." }, { status: 409 });
    }

    if (target === "staging") {
      const { getCoolifyAppStagingCapability } = await import("@/lib/coolify");
      const capability = await getCoolifyAppStagingCapability(
        resourceUuid,
        workspace.coolifyProjectId ?? undefined,
        { relaxedTargetMatch: true }
      );
      const stagingUuid = capability?.applicationUuid?.trim();
      if (!stagingUuid) {
        // Reporting production's versions under a staging heading would be a
        // quiet lie about which site you are looking at.
        return NextResponse.json({ ok: false, message: "No staging copy was found for this app." }, { status: 409 });
      }
      resourceUuid = stagingUuid;
    }

    const scriptPath = resolveScriptPath("site-wp-info.mjs");
    if (!scriptPath) {
      return NextResponse.json({ ok: false, message: "Info script not found." }, { status: 500 });
    }

    const stdout = await new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [scriptPath, "--resource-uuid", resourceUuid as string],
        { cwd: process.cwd(), env: process.env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
        (_error, out) => resolve(out ?? "")
      );
    });

    const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("SITE_WP_INFO_RESULT="));
    if (!line) {
      return NextResponse.json({ ok: false, message: "Could not read runtime details for this app." }, { status: 502 });
    }

    const payload = JSON.parse(line.slice("SITE_WP_INFO_RESULT=".length));
    return NextResponse.json({ ...payload, target }, { status: payload?.ok ? 200 : 409 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: `Could not read runtime details: ${error instanceof Error ? error.message : "unknown"}` },
      { status: 500 }
    );
  }
}
