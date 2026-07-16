import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";
import {
  normalizeTemporaryDomainSlug,
  resolveTemporaryDomainSuffix
} from "@/lib/temporary-domains";

type Params = { params: Promise<{ siteId: string }> };

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildSiteIdentityWhere(siteId: string) {
  const normalizedSiteId = decodeURIComponent(siteId).trim();

  if (!normalizedSiteId) {
    return {
      slug: siteId,
      deletedAt: null
    };
  }

  if (isUuid(normalizedSiteId)) {
    return {
      OR: [
        { id: normalizedSiteId },
        { slug: normalizedSiteId },
        { coolifyServiceUuid: normalizedSiteId },
        { coolifyServiceId: normalizedSiteId }
      ],
      deletedAt: null
    };
  }

  return {
    OR: [
      { slug: normalizedSiteId },
      { coolifyServiceUuid: normalizedSiteId },
      { coolifyServiceId: normalizedSiteId }
    ],
    deletedAt: null
  };
}

function isPrismaSchemaMismatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { code?: string; message?: string; meta?: { message?: string } };
  const message = `${e.message ?? ""} ${e.meta?.message ?? ""}`.toLowerCase();

  return (
    e.code === "P2022" ||
    (message.includes("column") && message.includes("does not exist")) ||
    (message.includes("the column") && message.includes("does not exist"))
  );
}

async function getSiteForUser(siteId: string, userId: string) {
  const { db } = await import("@/lib/db");

  return db.site.findFirst({
    where: {
      ...buildSiteIdentityWhere(siteId),
      OR: [
        {
          organization: {
            deletedAt: null,
            OR: [
              { ownerId: userId },
              { collaborators: { some: { userId, deletedAt: null } } }
            ]
          }
        },
        { collaborators: { some: { userId, deletedAt: null } } }
      ]
    },
    include: { organization: { select: { id: true, ownerId: true } } }
  });
}

/**
 * GET /api/sites/[siteId]
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  try {
    const { db } = await import("@/lib/db");

    const site = await db.site.findFirst({
      where: {
        ...buildSiteIdentityWhere(siteId),
        OR: [
          {
            organization: {
              deletedAt: null,
              OR: [
                { ownerId: session.user.id },
                { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
              ]
            }
          },
          { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
        ]
      },
      include: {
        environments: {
          include: {
            deployments: { orderBy: { triggeredAt: "desc" }, take: 5 }
          }
        },
        collaborators: { include: { user: { select: { id: true, email: true, fullName: true } } } },
        organization: { select: { id: true, slug: true, name: true } }
      }
    });

    if (!site) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: site.id,
      slug: site.slug,
      name: site.name,
      description: site.description,
      coolifyServiceId: site.coolifyServiceId,
      coolifyServiceUuid: site.coolifyServiceUuid,
      coolifyProjectId: site.coolifyProjectId,
      gitRepositoryUrl: site.gitRepositoryUrl,
      stagingEnabled: site.stagingEnabled,
      temporaryDomainSlug: site.temporaryDomainSlug,
      temporaryDomainSuffix: site.temporaryDomainSuffix,
      organizationId: site.organizationId,
      organization: site.organization,
      environments: site.environments,
      collaborators: site.collaborators.map((c: any) => ({
        userId: c.userId,
        role: c.role,
        email: c.user.email,
        fullName: c.user.fullName
      })),
      createdAt: site.createdAt,
      updatedAt: site.updatedAt
    });
  } catch (err) {
    console.error("GET /api/sites/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PUT /api/sites/[siteId]
 * Updates name/description/coolifyServiceUuid/coolifyProjectId/gitRepositoryUrl/stagingEnabled.
 * Requires owner or admin on the parent organization.
 */
export async function PUT(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  let body: {
    name?: string;
    description?: string;
    coolifyServiceUuid?: string;
    coolifyProjectId?: string;
    gitRepositoryUrl?: string;
    stagingEnabled?: boolean;
    temporaryDomainSlug?: string;
    temporaryDomainSuffix?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const { db } = await import("@/lib/db");

    const site = await db.site.findFirst({
      where: {
        ...buildSiteIdentityWhere(siteId),
        organization: {
          deletedAt: null,
          OR: [{ ownerId: session.user.id }, { collaborators: { some: { userId: session.user.id } } }]
        }
      },
      include: {
        organization: {
          select: { id: true, ownerId: true, collaborators: { where: { userId: session.user.id }, select: { role: true } } }
        }
      }
    });

    if (!site) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }

    const callerIsOwner = site.organization.ownerId === session.user.id;
    const callerIsAdmin = callerIsOwner || isAdminRole(site.organization.collaborators[0]?.role);
    if (!callerIsAdmin) {
      return NextResponse.json({ error: "Only admins can update apps" }, { status: 403 });
    }

    const name = body.name?.trim();
    const updates: {
      name?: string;
      slug?: string;
      description?: string | null;
      coolifyServiceUuid?: string | null;
      coolifyProjectId?: string | null;
      gitRepositoryUrl?: string | null;
      stagingEnabled?: boolean;
      temporaryDomainSlug?: string | null;
      temporaryDomainSuffix?: string | null;
    } = {};
    if (name) {
      updates.name = name;
      updates.slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
    }
    if ("description" in body) updates.description = body.description?.trim() || null;
    if ("coolifyServiceUuid" in body) updates.coolifyServiceUuid = body.coolifyServiceUuid?.trim() || null;
    if ("coolifyProjectId" in body) updates.coolifyProjectId = body.coolifyProjectId?.trim() || null;
    if ("gitRepositoryUrl" in body) updates.gitRepositoryUrl = body.gitRepositoryUrl?.trim() || null;
    if ("stagingEnabled" in body && typeof body.stagingEnabled === "boolean") updates.stagingEnabled = body.stagingEnabled;
    if ("temporaryDomainSlug" in body) {
      updates.temporaryDomainSlug = normalizeTemporaryDomainSlug(body.temporaryDomainSlug) || null;
    }
    if ("temporaryDomainSuffix" in body) {
      updates.temporaryDomainSuffix = resolveTemporaryDomainSuffix(body.temporaryDomainSuffix);
    }

    let updated;
    try {
      updated = await db.site.update({ where: { id: site.id }, data: updates });
    } catch (error) {
      if (!isPrismaSchemaMismatchError(error)) {
        throw error;
      }

      const { temporaryDomainSlug: _tmpSlug, temporaryDomainSuffix: _tmpSuffix, ...safeUpdates } = updates;
      updated = await db.site.update({ where: { id: site.id }, data: safeUpdates });
    }

    return NextResponse.json({ id: updated.id, slug: updated.slug, name: updated.name });
  } catch (err) {
    console.error("PUT /api/sites/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/sites/[siteId]
 * Soft-deletes the site. Requires owner or admin on the parent organization.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  try {
    const { db } = await import("@/lib/db");

    const site = await db.site.findFirst({
      where: {
        ...buildSiteIdentityWhere(siteId),
        organization: {
          deletedAt: null,
          OR: [{ ownerId: session.user.id }, { collaborators: { some: { userId: session.user.id } } }]
        }
      },
      include: {
        organization: {
          select: { id: true, ownerId: true, collaborators: { where: { userId: session.user.id }, select: { role: true } } }
        }
      }
    });

    if (!site) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }

    const callerIsOwner = site.organization.ownerId === session.user.id;
    const callerIsAdmin = callerIsOwner || isAdminRole(site.organization.collaborators[0]?.role);
    if (!callerIsAdmin) {
      return NextResponse.json({ error: "Only admins can delete apps" }, { status: 403 });
    }

    await db.site.update({ where: { id: site.id }, data: { deletedAt: new Date() } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/sites/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
