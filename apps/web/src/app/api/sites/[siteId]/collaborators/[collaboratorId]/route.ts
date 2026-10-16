import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { normalizeRole } from "@/lib/roles";
import { hasOnlyFields, isTenantMutationRole, resolveSiteAccess } from "@/lib/tenant-route-access";

type Params = { params: Promise<{ siteId: string; collaboratorId: string }> };

type CallerAccess = {
  siteId: string;
  callerRole: "admin" | "collaborator";
};

async function getCallerAccess(siteId: string, userId: string): Promise<CallerAccess | null> {
  const access = await resolveSiteAccess(siteId, userId);
  return access ? { siteId: access.site.id, callerRole: access.isAdmin ? "admin" : "collaborator" } : null;
}

export async function PUT(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId, collaboratorId } = await params;

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!hasOnlyFields(body, ["role"]) || !isTenantMutationRole(body.role)) {
    return NextResponse.json({ error: "role must be admin or collaborator" }, { status: 400 });
  }
  const requestedRole = normalizeRole(body.role);

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (access.callerRole !== "admin") {
      return NextResponse.json({ error: "Only admins can change app roles" }, { status: 403 });
    }

    const { db } = await import("@/lib/db");
    const collaborator = await db.siteCollaborator.findFirst({
      where: { id: collaboratorId, siteId: access.siteId }
    });

    if (!collaborator) {
      return NextResponse.json({ error: "Collaborator not found" }, { status: 404 });
    }

    const updated = await db.siteCollaborator.update({
      where: { id: collaboratorId, siteId: access.siteId },
      data: { role: requestedRole }
    });

    return NextResponse.json({ id: updated.id, role: normalizeRole(updated.role) });
  } catch (error) {
    console.error("PUT /api/sites/[siteId]/collaborators/[collaboratorId] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId, collaboratorId } = await params;

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (access.callerRole !== "admin") {
      return NextResponse.json({ error: "Only admins can remove app collaborators" }, { status: 403 });
    }

    const { db } = await import("@/lib/db");
    const deleted = await db.siteCollaborator.deleteMany({ where: { id: collaboratorId, siteId: access.siteId } });
    if (!deleted.count) {
      return NextResponse.json({ error: "Collaborator not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/sites/[siteId]/collaborators/[collaboratorId] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
