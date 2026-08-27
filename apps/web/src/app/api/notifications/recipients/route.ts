import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { checkIsPlatformAdmin } from "@/lib/permissions";

/**
 * GET /api/notifications/recipients
 *
 * Lightweight lists for the composer's recipient pickers: every client
 * (for the "Specific Client(s)" and "Specific App" pickers, apps are grouped
 * under their client) and every team member (for "Specific Team Member(s)").
 * Deliberately a direct, narrow query rather than reusing listClientWorkspaces
 * / listSiteDirectory — those merge in live Coolify status for the full
 * directory views, which this dropdown has no use for and would only slow down.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !checkIsPlatformAdmin(session.user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const clients = await db.organization.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      owner: { select: { id: true, email: true, fullName: true } },
      sites: { where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } },
      collaborators: {
        where: { deletedAt: null },
        select: { user: { select: { id: true, email: true, fullName: true } } }
      }
    }
  });

  const seenMembers = new Set<string>();
  const members: Array<{ id: string; email: string; fullName: string | null; clientName: string }> = [];
  const clientSummaries = clients.map((org: any) => {
    if (org.owner?.id && !seenMembers.has(org.owner.id)) {
      seenMembers.add(org.owner.id);
      members.push({ id: org.owner.id, email: org.owner.email, fullName: org.owner.fullName, clientName: org.name });
    }
    for (const c of org.collaborators) {
      if (c.user?.id && !seenMembers.has(c.user.id)) {
        seenMembers.add(c.user.id);
        members.push({ id: c.user.id, email: c.user.email, fullName: c.user.fullName, clientName: org.name });
      }
    }

    return {
      id: org.id,
      name: org.name,
      apps: org.sites.map((s: any) => ({ id: s.id, name: s.name }))
    };
  });

  return NextResponse.json({ clients: clientSummaries, members });
}
