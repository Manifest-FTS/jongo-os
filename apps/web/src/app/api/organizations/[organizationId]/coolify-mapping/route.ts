import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";

type Params = { params: Promise<{ organizationId: string }> };

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { coolifyProjectId, coolifyProjectName } = body as Record<string, unknown>;

  // Allow clearing by sending empty strings or null
  const normalizedProjectId =
    typeof coolifyProjectId === "string" && coolifyProjectId.trim().length > 0
      ? coolifyProjectId.trim()
      : null;
  const normalizedProjectName =
    typeof coolifyProjectName === "string" && coolifyProjectName.trim().length > 0
      ? coolifyProjectName.trim()
      : null;

  try {
    const organization = await db.organization.findFirst({
      where: {
        id: organizationId,
        OR: [
          { ownerId: session.user.id },
          { collaborators: { some: { userId: session.user.id } } }
        ]
      }
    });

    if (!organization) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const updated = await db.organization.update({
      where: { id: organizationId },
      data: {
        coolifyProjectId: normalizedProjectId,
        coolifyProjectName: normalizedProjectName
      }
    });

    return NextResponse.json({
      ok: true,
      coolifyProjectId: updated.coolifyProjectId,
      coolifyProjectName: updated.coolifyProjectName
    });
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "That Coolify Project is already mapped to another client." },
        { status: 409 }
      );
    }
    console.error("[jongo] coolify-mapping update failed:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
