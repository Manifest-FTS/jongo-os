import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { listCoolifyProjects } from "@/lib/coolify";

/**
 * GET /api/organizations/unmapped-coolify-projects
 *
 * Every Coolify project has to be deliberately linked to a Jongo client
 * (Organization.coolifyProjectId / OrganizationCoolifyProjectLink) -- there is
 * no automatic "one client per Coolify project" sync, so a project created
 * directly in Coolify (or via the old approved-mappings allowlist script)
 * can silently have no corresponding client here. This diffs Coolify's own
 * project list against every linked id so that gap is visible instead of
 * silent.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !(await isPlatformAdminEmail(session.user.email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  let projects;
  try {
    projects = await listCoolifyProjects();
  } catch (error) {
    console.error("GET /api/organizations/unmapped-coolify-projects: Coolify fetch failed:", error);
    return NextResponse.json({ error: "Could not reach Coolify" }, { status: 502 });
  }

  const linkedIds = await db.$queryRaw<Array<{ coolifyProjectId: string }>>`
    select "coolifyProjectId" from "Organization" where "coolifyProjectId" is not null and "deletedAt" is null
    union
    select "coolifyProjectId" from "OrganizationCoolifyProjectLink" where "deletedAt" is null
  `;
  const linked = new Set(linkedIds.map((row: { coolifyProjectId: string }) => row.coolifyProjectId));

  const unmapped = projects.filter((project) => !linked.has(project.id));

  return NextResponse.json({ unmapped });
}
