import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { destroyCoolifyApplication, getCoolifyOverview } from "@/lib/coolify";
import { hasOnlyFields, resolveSiteAccess } from "@/lib/tenant-route-access";
import {
  normalizeTemporaryDomainSlug,
  resolveTemporaryDomainSuffix
} from "@/lib/temporary-domains";

type Params = { params: Promise<{ siteId: string }> };

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

let hasCheckedTemporaryDomainColumns = false;
let temporaryDomainColumnsAvailable = false;

async function hasTemporaryDomainColumns(db: any): Promise<boolean> {
  if (hasCheckedTemporaryDomainColumns) {
    return temporaryDomainColumnsAvailable;
  }

  try {
    const columns = await db.$queryRaw<Array<{ columnName: string }>>`
      select column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'Site'
        and column_name in ('temporaryDomainSlug', 'temporaryDomainSuffix')
    `;

    const available = new Set(columns.map((column: { columnName: string }) => column.columnName));
    temporaryDomainColumnsAvailable =
      available.has("temporaryDomainSlug") && available.has("temporaryDomainSuffix");
    hasCheckedTemporaryDomainColumns = true;
    return temporaryDomainColumnsAvailable;
  } catch {
    hasCheckedTemporaryDomainColumns = true;
    temporaryDomainColumnsAvailable = false;
    return false;
  }
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
    const access = await resolveSiteAccess(siteId, session.user.id);
    if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const site = await db.site.findFirst({
      where: { id: access.site.id, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        coolifyServiceId: true,
        coolifyServiceUuid: true,
        coolifyProjectId: true,
        gitRepositoryUrl: true,
        stagingEnabled: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
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

    let temporaryDomainSlug: string | null = null;
    let temporaryDomainSuffix: string | null = null;
    if (await hasTemporaryDomainColumns(db)) {
      try {
        const temporaryDomainValues = await db.site.findUnique({
          where: { id: site.id },
          select: {
            temporaryDomainSlug: true,
            temporaryDomainSuffix: true
          }
        });
        temporaryDomainSlug = temporaryDomainValues?.temporaryDomainSlug ?? null;
        temporaryDomainSuffix = temporaryDomainValues?.temporaryDomainSuffix ?? null;
      } catch (error) {
        if (!isPrismaSchemaMismatchError(error)) {
          throw error;
        }

        hasCheckedTemporaryDomainColumns = true;
        temporaryDomainColumnsAvailable = false;
      }
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
      temporaryDomainSlug,
      temporaryDomainSuffix,
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
 * Site/client admins may edit settings; infrastructure bindings are platform-only.
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

  if (!hasOnlyFields(body, ["name", "description", "coolifyServiceUuid", "coolifyProjectId", "gitRepositoryUrl", "stagingEnabled", "temporaryDomainSlug", "temporaryDomainSuffix"])) {
    return NextResponse.json({ error: "Unsupported app settings" }, { status: 400 });
  }

  try {
    const { db } = await import("@/lib/db");

    const access = await resolveSiteAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }
    const { site } = access;
    if (!access.isPlatformAdmin && ("coolifyServiceUuid" in body || "coolifyProjectId" in body)) {
      return NextResponse.json({ error: "Only platform admins can change infrastructure bindings" }, { status: 403 });
    }

    const collaboratorAllowedFields = new Set(["temporaryDomainSlug", "temporaryDomainSuffix"]);
    const requestedFields = Object.keys(body).filter((key) => Object.prototype.hasOwnProperty.call(body, key));
    const collaboratorOnlyUpdate =
      requestedFields.length > 0 && requestedFields.every((field) => collaboratorAllowedFields.has(field));

    if (!access.isAdmin && !collaboratorOnlyUpdate) {
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
      updated = await db.site.update({
        where: { id: site.id },
        data: updates,
        select: { id: true, slug: true, name: true }
      });
    } catch (error) {
      if (!isPrismaSchemaMismatchError(error)) {
        throw error;
      }

      if ("temporaryDomainSlug" in updates || "temporaryDomainSuffix" in updates) {
        return NextResponse.json({
          error: "Temporary domain settings are not writable yet because the database migration is missing on this environment."
        }, { status: 409 });
      }

      const { temporaryDomainSlug: _tmpSlug, temporaryDomainSuffix: _tmpSuffix, ...safeUpdates } = updates;
      updated = await db.site.update({
        where: { id: site.id },
        data: safeUpdates,
        select: { id: true, slug: true, name: true }
      });
    }

    return NextResponse.json({ id: updated.id, slug: updated.slug, name: updated.name });
  } catch (err) {
    console.error("PUT /api/sites/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/sites/[siteId]
 * Soft-deletes the site. Requires site/client admin or platform authority.
 */
export async function DELETE(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  let deleteCoolifyResource = false;
  let forceArchiveOnCoolifyFailure = false;
  try {
    const body = await req.json();
    deleteCoolifyResource = body?.deleteCoolifyResource === true;
    forceArchiveOnCoolifyFailure = body?.force === true;
  } catch {
    deleteCoolifyResource = false;
  }

  try {
    const { db } = await import("@/lib/db");

    const access = await resolveSiteAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }
    const { site } = access;
    if (!access.isAdmin) {
      return NextResponse.json({ error: "Only admins can delete apps" }, { status: 403 });
    }

    let coolifyDestroyed = false;
    let coolifyDeletionMessage: string | undefined;

    if (deleteCoolifyResource && site.coolifyServiceUuid?.trim()) {
      // Legacy tenant-writable bindings are not sufficient authority to destroy
      // infrastructure. Fail closed on unavailable inventory or project drift;
      // force only handles provider failures, never an authorization failure.
      if (!access.isPlatformAdmin) {
        const overview = await getCoolifyOverview();
        const resource = overview.sites.find((row) => row.deployTargetId === site.coolifyServiceUuid!.trim());
        const projectId = site.coolifyProjectId?.trim();
        const links = projectId ? await db.$queryRaw<Array<{ organizationId: string }>>`
          select distinct o.id as "organizationId"
          from "Organization" o
          left join "OrganizationCoolifyProjectLink" l on l."organizationId" = o.id and l."deletedAt" is null
          where o."deletedAt" is null
            and (o."coolifyProjectId" = ${projectId} or l."coolifyProjectId" = ${projectId})
        ` : [];
        const conflictingSite = await db.site.findFirst({ where: {
          deletedAt: null, coolifyServiceUuid: site.coolifyServiceUuid.trim(),
          id: { not: site.id }
        }, select: { id: true } });
        if (overview.mode !== "live" || overview.fetchError || !resource || !projectId ||
          resource.coolifyProjectId !== projectId || links.length !== 1 ||
          links[0].organizationId !== site.organization.id || conflictingSite) {
          return NextResponse.json({ error: "Infrastructure binding could not be verified. Contact a platform admin." }, { status: 409 });
        }
      }
      const deletion = await destroyCoolifyApplication(site.coolifyServiceUuid.trim());
      coolifyDestroyed = deletion.ok;
      coolifyDeletionMessage = deletion.message;

      // Archiving the Jongo row after a FAILED Coolify deletion is the exact
      // divergence this sync exists to prevent: Jongo would report the app gone
      // while the resource keeps running and billing, and with the row archived
      // nothing is left pointing at it. Refuse instead, so the operator can
      // retry — or pass force to accept the orphan knowingly.
      if (!coolifyDestroyed && !forceArchiveOnCoolifyFailure) {
        try {
          await db.auditLog.create({
            data: {
              organizationId: site.organization.id,
              actorId: session.user.id,
              action: "site_updated",
              resourceType: "site",
              resourceId: site.id,
              details: {
                actionType: "coolify_deletion_failed_archive_refused",
                coolifyServiceUuid: site.coolifyServiceUuid,
                coolifyDeletionMessage,
                message: "Coolify refused the resource deletion, so the Jongo app was left in place."
              },
              ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
              userAgent: req.headers.get("user-agent") ?? undefined
            }
          });
        } catch {
          // Reporting the refusal matters more than logging it.
        }

        return NextResponse.json({
          ok: false,
          coolifyDeletionRequested: true,
          coolifyDestroyed: false,
          coolifyDeletionMessage,
          error:
            `The running site could not be deleted${coolifyDeletionMessage ? ` (${coolifyDeletionMessage})` : ""}. ` +
            "The app was kept so nothing is left running unseen. Use Retry delete.",
          actionHint: "Use Retry delete. Nothing has been removed yet.",
          remedy: { action: "retry_site_delete", label: "Retry delete" }
        }, { status: 502 });
      }
    }

    await db.site.update({ where: { id: site.id }, data: { deletedAt: new Date() } });

    try {
      await db.auditLog.create({
        data: {
          organizationId: site.organization.id,
          actorId: session.user.id,
          action: "site_deleted",
          resourceType: "site",
          resourceId: site.id,
          details: {
            actionType: "site_archived",
            coolifyServiceUuid: site.coolifyServiceUuid ?? null,
            coolifyDeletionRequested: deleteCoolifyResource,
            coolifyDestroyed,
            forcedDespiteCoolifyFailure: deleteCoolifyResource && !coolifyDestroyed,
            coolifyDeletionMessage: coolifyDeletionMessage ?? null
          },
          ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
          userAgent: req.headers.get("user-agent") ?? undefined
        }
      });
    } catch (error) {
      console.error("[jongo] DELETE /api/sites/[id]: audit log failed", error);
    }

    return NextResponse.json({
      ok: true,
      coolifyDeletionRequested: deleteCoolifyResource,
      coolifyDestroyed,
      coolifyDeletionMessage,
      forcedDespiteCoolifyFailure: deleteCoolifyResource && !coolifyDestroyed
    });
  } catch (err) {
    console.error("DELETE /api/sites/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const PATCH = PUT;
