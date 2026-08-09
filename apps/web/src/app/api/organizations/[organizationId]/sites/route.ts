import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { ensureCoolifyAppBackupSchedules, getCoolifyOverview, provisionCoolifyWordPressService } from "@/lib/coolify";
import { isAdminRole } from "@/lib/roles";
import {
  buildTemporaryProductionDomain,
  normalizeTemporaryDomainSlug,
  resolveTemporaryDomainSuffix
} from "@/lib/temporary-domains";

type Params = { params: Promise<{ organizationId: string }> };

function isPrismaUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { code?: string };
  return e.code === "P2002";
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

/**
 * GET /api/organizations/[organizationId]/sites
 * Returns all sites in an organization the user has access to.
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  try {
    const { db } = await import("@/lib/db");

    // Verify the user has access to this org
    const org = await db.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        OR: [
          { ownerId: session.user.id },
          { collaborators: { some: { userId: session.user.id } } }
        ]
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const sites = await db.site.findMany({
      where: { organizationId, deletedAt: null },
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
        environments: { select: { id: true, name: true, isProductionLike: true } }
      },
      orderBy: { name: "asc" }
    });

    return NextResponse.json(
      sites.map((site: any) => ({
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
        environments: site.environments,
        createdAt: site.createdAt
      }))
    );
  } catch (err) {
    console.error("GET /api/organizations/[id]/sites error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/organizations/[organizationId]/sites
 * Creates a new site in the organization.
 * Body: { name: string; description?: string; coolifyServiceUuid?: string; gitRepositoryUrl?: string }
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  let body: {
    name?: string;
    description?: string;
    coolifyServiceUuid?: string;
    /** Create a new WordPress site in Coolify instead of linking an existing one. */
    provisionWordPress?: boolean;
    gitRepositoryUrl?: string;
    temporaryDomainSlug?: string;
    temporaryDomainSuffix?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const pinnedTemporarySlug = normalizeTemporaryDomainSlug(body.temporaryDomainSlug) || slug;
  const pinnedTemporarySuffix = resolveTemporaryDomainSuffix(body.temporaryDomainSuffix);

  try {
    const { db } = await import("@/lib/db");

    // Only owner or admin can create sites
    const org = await db.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        OR: [{ ownerId: session.user.id }, { collaborators: { some: { userId: session.user.id } } }]
      },
      include: {
        collaborators: {
          where: { userId: session.user.id },
          select: { role: true }
        }
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }

    const callerIsOwner = org.ownerId === session.user.id;
    const callerIsAdmin = callerIsOwner || isAdminRole(org.collaborators[0]?.role);
    if (!callerIsAdmin) {
      return NextResponse.json({ error: "Only admins can create apps" }, { status: 403 });
    }

    // Two different intents share this endpoint: ADOPT an existing Coolify
    // resource (paste its uuid), or CREATE one. Only the first ever worked —
    // adding an app wrote a row and left Coolify untouched, so the app existed
    // in Jongo and nowhere else.
    let coolifyServiceUuid = body.coolifyServiceUuid?.trim() || null;
    let provisionMessage: string | null = null;
    let provisionDomainApplied: boolean | null = null;
    let provisionDomain: string | null = null;
    let provisionedProjectUuid: string | null = null;

    if (body.provisionWordPress === true && !coolifyServiceUuid) {
      // Reuses the org loaded above, which is already access-checked; a second
      // lookup here would bypass that check and shadow the outer binding.
      // The same domain the operator sees in the form. Building it here rather
      // than letting Coolify assign a generated host is the whole point: the
      // site should come up on the address it was created with.
      const desiredDomain = buildTemporaryProductionDomain({
        slug: pinnedTemporarySlug,
        suffix: pinnedTemporarySuffix
      });
      const provision = await provisionCoolifyWordPressService({
        name,
        projectUuid: org.coolifyProjectId ?? null,
        environmentName: "production",
        domain: desiredDomain ?? null
      });
      if (!provision.ok || !provision.uuid) {
        // Refuse rather than fall back to creating a row with no infrastructure
        // behind it — that is the very state this feature exists to end.
        return NextResponse.json(
          { error: provision.message, reason: provision.reason ?? "provision_failed" },
          { status: 502 }
        );
      }
      coolifyServiceUuid = provision.uuid;
      provisionMessage = provision.message;
      // Not fatal — the site exists — but the caller must be told, or someone
      // goes looking for a domain that was never applied.
      provisionDomainApplied = provision.domainApplied ?? null;
      provisionDomain = provision.domain ?? desiredDomain ?? null;
      provisionedProjectUuid = org.coolifyProjectId ?? null;
    }

    let coolifyProjectId: string | null = null;
    let coolifyProjectName: string | null = null;

    if (coolifyServiceUuid) {
      const overview = await getCoolifyOverview();
      const matched = overview.sites.find(
        (site) => site.id === coolifyServiceUuid || site.deployTargetId === coolifyServiceUuid
      );
      // The overview is cached (COOLIFY_OVERVIEW_TTL_MS, 5s by default) and a
      // service created moments ago may not be in it yet. When we provisioned it
      // ourselves the project is not a guess — it is the one we asked Coolify to
      // create in — so fall back to it rather than storing null and leaving the
      // site unable to resolve its own project later.
      coolifyProjectId = matched?.coolifyProjectId ?? provisionedProjectUuid ?? null;
      coolifyProjectName = matched?.coolifyProjectName ?? null;

      if (coolifyProjectId && !org.coolifyProjectId) {
        try {
          await db.organization.update({
            where: { id: organizationId },
            data: {
              coolifyProjectId,
              coolifyProjectName: coolifyProjectName ?? undefined
            }
          });
        } catch (error) {
          if (!isPrismaUniqueConstraintError(error)) {
            throw error;
          }

          console.warn(
            "POST /api/organizations/[id]/sites: organization project backfill skipped due to uniqueness conflict.",
            organizationId,
            coolifyProjectId
          );
        }
      }
    }

    let site: any;
    try {
      site = await db.site.create({
        data: {
          organizationId,
          slug,
          name,
          description: body.description?.trim() || null,
          coolifyServiceUuid,
          coolifyProjectId,
          stagingEnabled: false,
          gitRepositoryUrl: body.gitRepositoryUrl?.trim() || null,
          temporaryDomainSlug: pinnedTemporarySlug,
          temporaryDomainSuffix: pinnedTemporarySuffix,
          environments: {
            create: [
              { name: "production", isProductionLike: true },
              { name: "staging", isProductionLike: false }
            ]
          }
        },
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          coolifyServiceUuid: true,
          coolifyProjectId: true,
          stagingEnabled: true,
          gitRepositoryUrl: true,
          organizationId: true,
          createdAt: true,
          environments: { select: { id: true, name: true, isProductionLike: true } }
        }
      });
    } catch (error) {
      if (!isPrismaSchemaMismatchError(error)) {
        throw error;
      }

      // Compatibility fallback when DB is missing temporary-domain columns.
      site = await db.site.create({
        data: {
          organizationId,
          slug,
          name,
          description: body.description?.trim() || null,
          coolifyServiceUuid,
          coolifyProjectId,
          stagingEnabled: false,
          gitRepositoryUrl: body.gitRepositoryUrl?.trim() || null,
          environments: {
            create: [
              { name: "production", isProductionLike: true },
              { name: "staging", isProductionLike: false }
            ]
          }
        },
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          coolifyServiceUuid: true,
          coolifyProjectId: true,
          stagingEnabled: true,
          gitRepositoryUrl: true,
          organizationId: true,
          createdAt: true,
          environments: { select: { id: true, name: true, isProductionLike: true } }
        }
      });
    }

    let backupReconciliation: Awaited<ReturnType<typeof ensureCoolifyAppBackupSchedules>> | null = null;
    if (coolifyServiceUuid) {
      try {
        backupReconciliation = await ensureCoolifyAppBackupSchedules(coolifyServiceUuid);
      } catch (backupError) {
        console.error("POST /api/organizations/[id]/sites backup auto-provision failed:", backupError);
      }
    }

    return NextResponse.json(
      {
        id: site.id,
        slug: site.slug,
        name: site.name,
        description: site.description,
        coolifyServiceUuid: site.coolifyServiceUuid,
        coolifyProjectId: site.coolifyProjectId,
        stagingEnabled: site.stagingEnabled,
        gitRepositoryUrl: site.gitRepositoryUrl,
        temporaryDomainSlug: site.temporaryDomainSlug,
        temporaryDomainSuffix: site.temporaryDomainSuffix,
        organizationId: site.organizationId,
        environments: site.environments,
        createdAt: site.createdAt,
        backupReconciliation,
        // Provisioning can half-succeed: the service is created but the domain
        // is refused or times out. Reporting 201 without this reads as complete
        // success and leaves the site on a Coolify-generated host with nobody
        // aware of it.
        provision: provisionMessage
          ? { message: provisionMessage, domain: provisionDomain, domainApplied: provisionDomainApplied }
          : null
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("POST /api/organizations/[id]/sites error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
