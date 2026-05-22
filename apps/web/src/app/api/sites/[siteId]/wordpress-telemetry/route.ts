import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { getSiteWorkspace } from "@/lib/repositories";
import { getWordPressTelemetrySnapshot } from "@/lib/wordpress-telemetry";
import { getWordPressTelemetrySnapshotFromCollector } from "@/lib/wordpress-telemetry-collector";
import type { SiteWorkspaceRecord } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildIdentityMatchers(values: string[]) {
  return values.flatMap((value): Array<Record<string, string>> =>
    isUuid(value)
      ? [
          { id: value },
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value }
        ]
      : [
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value },
          { name: value }
        ]
  );
}

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasBootstrapGlobalAccess(email?: string | null): boolean {
  const configured = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const viewer = normalizeEmail(email);
  return Boolean(configured && viewer && configured === viewer);
}

function toSiteSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function ensureSiteRecordForWorkspace(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspace: SiteWorkspaceRecord,
  fallbackSiteId: string
): Promise<string | null> {
  const organization = await db.organization.findFirst({
    where: {
      deletedAt: null,
      OR: [{ slug: workspace.clientId }, { name: workspace.clientName }]
    },
    select: { id: true }
  });

  if (!organization) {
    return null;
  }

  const slug = toSiteSlug(workspace.slug ?? fallbackSiteId ?? workspace.name);

  const existing = await db.site.findFirst({
    where: {
      deletedAt: null,
      organizationId: organization.id,
      OR: [
        { slug },
        { coolifyServiceId: workspace.id },
        ...(workspace.coolifyServiceUuid ? [{ coolifyServiceUuid: workspace.coolifyServiceUuid }] : []),
        ...(workspace.deployTargetId ? [{ coolifyServiceId: workspace.deployTargetId }] : []),
        ...(workspace.coolifyProjectId ? [{ coolifyProjectId: workspace.coolifyProjectId }] : [])
      ]
    },
    select: { id: true }
  });

  if (existing?.id) {
    return existing.id;
  }

  const created = await db.site.create({
    data: {
      organizationId: organization.id,
      slug,
      name: workspace.name,
      coolifyServiceId: workspace.id || workspace.deployTargetId || null,
      coolifyServiceUuid:
        workspace.coolifyServiceUuid ||
        (isUuid(workspace.id) ? workspace.id : null) ||
        (workspace.deployTargetId && isUuid(workspace.deployTargetId) ? workspace.deployTargetId : null),
      coolifyProjectId: workspace.coolifyProjectId || null,
      coolifyProjectName: workspace.coolifyProjectName || null
    },
    select: { id: true }
  });

  return created.id;
}

async function resolveAuthorizedSiteDbId(
  siteId: string,
  userId: string,
  workspace: SiteWorkspaceRecord,
  viewerEmail?: string | null
): Promise<string | null> {
  const db = await getDb();
  if (!db) {
    return null;
  }

  const identifiers = [
    siteId,
    workspace.id,
    workspace.slug,
    workspace.coolifyServiceUuid,
    workspace.coolifyProjectId,
    workspace.name
  ]
    .map((value) => value?.trim() || "")
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);

  const identityMatchers = buildIdentityMatchers(identifiers);
  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(viewerEmail);

  const site = await db.site.findFirst({
    where: {
      AND: [
        {
          deletedAt: null,
          OR: identityMatchers as any
        },
        ...(workspace.organizationId ? [{ organizationId: workspace.organizationId }] : []),
        ...(bootstrapGlobalAccess
          ? []
          : [
              {
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
              }
            ])
      ]
    },
    select: { id: true }
  });

  if (site?.id) {
    return site.id;
  }

  if (bootstrapGlobalAccess) {
    return ensureSiteRecordForWorkspace(db, workspace, siteId);
  }

  return null;
}

/**
 * GET /api/sites/[siteId]/wordpress-telemetry
 * Read-only WordPress telemetry snapshot endpoint.
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  try {
    const workspace = await getSiteWorkspace(siteId, {
      userId: session.user.id,
      email: session.user.email
    });

    if (!workspace) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const fallbackSnapshot = getWordPressTelemetrySnapshot({
      siteId: workspace.slug ?? workspace.id,
      isWordPress: workspace.siteType === "wordpress",
      hasCoolifyServiceUuid: Boolean(workspace.coolifyServiceUuid)
    });

    const collectorSnapshot = await getWordPressTelemetrySnapshotFromCollector({
      fallback: fallbackSnapshot,
      workspace,
      requestedSiteId: siteId,
      preferredSiteDbId: await resolveAuthorizedSiteDbId(siteId, session.user.id, workspace, session.user.email)
    });

    const snapshot = collectorSnapshot ?? fallbackSnapshot;

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("GET /api/sites/[siteId]/wordpress-telemetry error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}