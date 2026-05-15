import { getClients, getClientById as getMockClientById, getClientForSite, type ClientRecord } from "./clients";
import { getCoolifyOverview } from "./coolify";

export type ViewerContext = {
  userId?: string;
  email?: string;
};

function isUuid(value?: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getScopedViewerUserId(viewer?: ViewerContext): string | undefined {
  if (!viewer?.userId) {
    return undefined;
  }

  if (isUuid(viewer.userId)) {
    return viewer.userId;
  }

  console.error(
    "[jongo] Ignoring non-UUID viewer user id while building DB filters.",
    "viewer.userId:", viewer.userId
  );
  return undefined;
}

function isPrismaUuidMismatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { code?: string; message?: string; meta?: { code?: string; message?: string } };
  const message = `${e.message ?? ""} ${e.meta?.message ?? ""}`.toLowerCase();

  return e.code === "P2023" || message.includes("error creating uuid") || message.includes("invalid character");
}

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasBootstrapGlobalAccess(viewer?: ViewerContext): boolean {
  const configuredAdmin = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const viewerEmail = normalizeEmail(viewer?.email);

  if (!configuredAdmin || !viewerEmail) {
    return false;
  }

  return configuredAdmin === viewerEmail;
}

export type ClientWorkspaceRecord = ClientRecord & {
  dbId?: string; // actual DB UUID (undefined when using mock data)
  siteCount: number;
  memberCount: number;
  /** Where this record was sourced from – "db" means a live Prisma query succeeded. */
  dataSource: "db" | "mock";
};

export type SiteDirectoryRecord = {
  id: string;           // DB UUID when available, Coolify ID otherwise
  name: string;
  deployTargetId: string;
  clientId: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  source: "db" | "coolify"; // where the record originates
  coolifyServiceUuid?: string;
  description?: string;
};

export type SiteWorkspaceRecord = {
  id: string;           // DB UUID when available, Coolify ID otherwise
  name: string;
  description?: string;
  deployTargetId: string;
  clientId: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  productionStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingStatus: "healthy" | "degraded" | "error" | "unknown";
  deploymentCount: number;
  recentActivity: string[];
  siteType: "wordpress" | "generic";
  // DB-native fields (only present for DB-backed sites)
  coolifyServiceUuid?: string;
  gitRepositoryUrl?: string;
  organizationId?: string;
  source: "db" | "coolify";
};

export type ActivityFeedItem = {
  id: string;
  title: string;
  detail: string;
  timestamp?: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  actor?: string;
  environment?: "production" | "staging" | "unknown";
  durationSeconds?: number;
};

function fromMockClients(): ClientWorkspaceRecord[] {
  return getClients().map((client) => ({
    ...client,
    siteCount: client.siteIds.length,
    memberCount: client.members.length,
    dataSource: "mock" as const
  }));
}

function getClientForCoolifySite(siteId: string, mode: "live" | "mock") {
  if (mode !== "mock") {
    return undefined;
  }

  return getClientForSite(siteId);
}

async function maybeGetDb(): Promise<any | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  try {
    const module = await import("./db");
    return await module.getDb();
  } catch (error) {
    console.error("[jongo] Failed to load Prisma client for database access.", error);
    return null;
  }
}

export async function getActivityFeed(limit = 6): Promise<ActivityFeedItem[]> {
  const overview = await getCoolifyOverview();
  const deploymentItems: ActivityFeedItem[] = overview.deployments.slice(0, limit).map((deployment) => ({
    id: deployment.id,
    title: deployment.environment === "unknown" ? deployment.siteName : `${deployment.siteName} → ${deployment.environment}`,
    detail: deployment.commitMessage ?? `Deployment ${deployment.status}`,
    timestamp: deployment.finishedAt,
    status: deployment.status,
    environment: deployment.environment,
    durationSeconds: deployment.durationSeconds
  }));

  const prisma = await maybeGetDb();

  if (!prisma) {
    return deploymentItems;
  }

  try {
    const auditLogs: any[] = await prisma.auditLog.findMany({
      take: limit,
      orderBy: { createdAt: "desc" }
    });

    const auditItems: ActivityFeedItem[] = auditLogs.map((log: any) => ({
      id: log.id,
      title: log.action,
      detail: log.resourceType ? `${log.resourceType}${log.resourceId ? ` ${log.resourceId}` : ""}` : "Audit event",
      timestamp: log.createdAt?.toISOString?.(),
      status: log.action.includes("deploy") ? "healthy" : "unknown"
    }));

    return [...auditItems, ...deploymentItems].slice(0, limit);
  } catch {
    return deploymentItems;
  }
}

export async function getSiteActivityFeed(siteId: string, limit = 6): Promise<ActivityFeedItem[]> {
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);

  if (!site) {
    return [];
  }

  return overview.deployments
    .filter((deployment) => deployment.siteName === site.name)
    .slice(0, limit)
    .map((deployment) => ({
      id: deployment.id,
      title: deployment.environment === "unknown" ? site.name : `${site.name} → ${deployment.environment}`,
      detail: deployment.commitMessage ?? `Deployment ${deployment.status}`,
      timestamp: deployment.finishedAt,
      status: deployment.status,
      environment: deployment.environment,
      durationSeconds: deployment.durationSeconds
    }));
}

async function readRealClientWorkspaces(viewer?: ViewerContext): Promise<ClientWorkspaceRecord[]> {
  const prisma = await maybeGetDb();

  if (!prisma) {
    return fromMockClients();
  }

  const whereClause: any = { deletedAt: null };
  const scopedUserId = getScopedViewerUserId(viewer);
  if (scopedUserId && !hasBootstrapGlobalAccess(viewer)) {
    whereClause.OR = [
      { ownerId: scopedUserId },
      { collaborators: { some: { userId: scopedUserId } } }
    ];
  }

  const organizations: any[] = await prisma.organization.findMany({
    where: whereClause,
    include: {
      sites: {
        include: {
          collaborators: {
            include: { user: true }
          },
          environments: {
            include: { deployments: true }
          }
        }
      },
      collaborators: {
        include: { user: true }
      }
    },
    orderBy: { name: "asc" }
  });

  return organizations.map((organization: any) => ({
    id: organization.slug,
    dbId: organization.id,
    dataSource: "db" as const,
    name: organization.name,
    summary: organization.description ?? "Client workspace",
    siteIds: organization.sites.map((site: any) => site.id),
    members: organization.collaborators.map((collaborator: any) => ({
      name: collaborator.user.fullName ?? collaborator.user.email,
      role: collaborator.role
    })),
    recentActivity: organization.sites.flatMap((site: any) =>
      site.environments.flatMap((environment: any) =>
        environment.deployments.slice(0, 1).map((deployment: any) => `Deployment ${deployment.status} on ${site.name}`)
      )
    ),
    siteCount: organization.sites.length,
    memberCount: organization.collaborators.length
  }));
}

export async function listClientWorkspaces(viewer?: ViewerContext): Promise<ClientWorkspaceRecord[]> {
  try {
    return await readRealClientWorkspaces(viewer);
  } catch (error) {
    if (isPrismaUuidMismatchError(error)) {
      console.error(
        "[jongo] listClientWorkspaces: Prisma UUID mismatch (P2023).",
        "This is usually caused by a non-UUID session user id or legacy text IDs in UUID-filtered paths.",
        "viewer.userId:", viewer?.userId,
        "Error:", error
      );
    }

    console.error(
      "[jongo] listClientWorkspaces: DB query failed after the connection check, falling back to mock data.",
      "DATABASE_URL present:", !!process.env.DATABASE_URL,
      "Error:", error
    );
    return fromMockClients();
  }
}

export async function getClientWorkspace(clientId: string, viewer?: ViewerContext): Promise<ClientWorkspaceRecord | undefined> {
  try {
    const prisma = await maybeGetDb();

    if (!prisma) {
      const mockClient = getMockClientById(clientId);

      if (!mockClient) return undefined;

      return {
        ...mockClient,
        siteCount: mockClient.siteIds.length,
        memberCount: mockClient.members.length,
        dataSource: "mock" as const
      };
    }

    const whereClause: any = { slug: clientId };
    const scopedUserId = getScopedViewerUserId(viewer);
    if (scopedUserId && !hasBootstrapGlobalAccess(viewer)) {
      whereClause.OR = [
        { ownerId: scopedUserId },
        { collaborators: { some: { userId: scopedUserId } } }
      ];
    }

    const organization: any = await prisma.organization.findFirst({
      where: whereClause,
      include: {
        sites: {
          include: {
            collaborators: {
              include: { user: true }
            },
            environments: {
              include: { deployments: true }
            }
          }
        },
        collaborators: {
          include: { user: true }
        }
      }
    });

    if (!organization) return undefined;

    return {
      id: organization.slug,
      dbId: organization.id,
      dataSource: "db" as const,
      name: organization.name,
      summary: organization.description ?? "Client workspace",
      siteIds: organization.sites.map((site: any) => site.id),
      members: organization.collaborators.map((collaborator: any) => ({
        name: collaborator.user.fullName ?? collaborator.user.email,
        role: collaborator.role
      })),
      recentActivity: organization.sites.flatMap((site: any) =>
        site.environments.flatMap((environment: any) =>
          environment.deployments.slice(0, 1).map((deployment: any) => `Deployment ${deployment.status} on ${site.name}`)
        )
      ),
      siteCount: organization.sites.length,
      memberCount: organization.collaborators.length
    };
  } catch (error) {
    console.error(
      "[jongo] getClientWorkspace: DB query failed, falling back to mock data.",
      "DATABASE_URL present:", !!process.env.DATABASE_URL,
      "Error:", error
    );
    const mockClient = getMockClientById(clientId);

    if (!mockClient) return undefined;

    return {
      ...mockClient,
      siteCount: mockClient.siteIds.length,
      memberCount: mockClient.members.length,
      dataSource: "mock" as const
    };
  }
}

export async function listSiteDirectory(viewer?: ViewerContext): Promise<SiteDirectoryRecord[]> {
  try {
    const prisma = await maybeGetDb();
    const overview = await getCoolifyOverview();

    if (!prisma) {
      return overview.sites.map((site) => {
        const client = getClientForCoolifySite(site.id, overview.mode);
        return {
          id: site.id,
          name: site.name,
          deployTargetId: site.deployTargetId,
          clientId: client?.id ?? "unassigned",
          clientName: client?.name ?? "Unassigned",
          status: site.status,
          source: "coolify" as const
        };
      });
    }

    // --- DB sites (user-scoped) ---
    const orgWhere: any = { deletedAt: null };
    const scopedUserId = getScopedViewerUserId(viewer);
    if (scopedUserId && !hasBootstrapGlobalAccess(viewer)) {
      orgWhere.OR = [
        { ownerId: scopedUserId },
        { collaborators: { some: { userId: scopedUserId } } }
      ];
    }

    const dbSites: any[] = await prisma.site.findMany({
      where: { deletedAt: null, organization: orgWhere },
      include: { organization: { select: { id: true, slug: true, name: true } } },
      orderBy: { name: "asc" }
    });

    // Track which Coolify UUIDs are already represented by DB records
    const coveredCoolifyUuids = new Set(
      dbSites.map((s: any) => s.coolifyServiceUuid).filter(Boolean)
    );

    const dbRecords: SiteDirectoryRecord[] = dbSites.map((s: any) => {
      const coolifyMatch = s.coolifyServiceUuid
        ? overview.sites.find((cs) => cs.deployTargetId === s.coolifyServiceUuid || cs.id === s.coolifyServiceUuid)
        : undefined;

      return {
        id: s.id,
        name: s.name,
        description: s.description ?? undefined,
        deployTargetId: coolifyMatch?.deployTargetId ?? s.coolifyServiceUuid ?? "",
        clientId: s.organization.slug,
        clientName: s.organization.name,
        status: coolifyMatch?.status ?? "unknown",
        source: "db" as const,
        coolifyServiceUuid: s.coolifyServiceUuid ?? undefined
      };
    });

    // --- Coolify-only sites (not linked to any DB record) ---
    const coolifyOnlyRecords: SiteDirectoryRecord[] = overview.sites
      .filter((cs) => !coveredCoolifyUuids.has(cs.id) && !coveredCoolifyUuids.has(cs.deployTargetId))
      .map((site) => {
        const client = getClientForCoolifySite(site.id, overview.mode);
        return {
          id: site.id,
          name: site.name,
          deployTargetId: site.deployTargetId,
          clientId: client?.id ?? "unassigned",
          clientName: client?.name ?? "Unassigned",
          status: site.status,
          source: "coolify" as const,
          coolifyServiceUuid: site.id
        };
      });

    return [...dbRecords, ...coolifyOnlyRecords];
  } catch (error) {
    console.error(
      "[jongo] listSiteDirectory: DB query failed, falling back to Coolify-only data.",
      "DATABASE_URL present:", !!process.env.DATABASE_URL,
      "Error:", error
    );
    const overview = await getCoolifyOverview();
    return overview.sites.map((site) => {
      const client = getClientForCoolifySite(site.id, overview.mode);
      return {
        id: site.id,
        name: site.name,
        deployTargetId: site.deployTargetId,
        clientId: client?.id ?? "unassigned",
        clientName: client?.name ?? "Unassigned",
        status: site.status,
        source: "coolify" as const
      };
    });
  }
}

export async function getSiteWorkspace(siteId: string): Promise<SiteWorkspaceRecord | undefined> {
  try {
    const prisma = await maybeGetDb();
    const overview = await getCoolifyOverview();

    if (prisma) {
      // Try DB lookup first (siteId may be a DB UUID)
      const dbSite: any = await prisma.site.findFirst({
        where: { id: siteId, deletedAt: null },
        include: {
          organization: { select: { id: true, slug: true, name: true } },
          environments: { include: { deployments: { orderBy: { triggeredAt: "desc" }, take: 3 } } }
        }
      });

      if (dbSite) {
        // Enrich with Coolify data if UUID is stored
        const coolifyMatch = dbSite.coolifyServiceUuid
          ? overview.sites.find(
              (cs) => cs.id === dbSite.coolifyServiceUuid || cs.deployTargetId === dbSite.coolifyServiceUuid
            )
          : undefined;

        const recentActivity = dbSite.environments.flatMap((env: any) =>
          env.deployments.map((dep: any) => `${env.name} ${dep.status}`)
        );

        return {
          id: dbSite.id,
          name: dbSite.name,
          description: dbSite.description ?? undefined,
          deployTargetId: coolifyMatch?.deployTargetId ?? dbSite.coolifyServiceUuid ?? "",
          clientId: dbSite.organization.slug,
          clientName: dbSite.organization.name,
          status: coolifyMatch?.status ?? "unknown",
          productionStatus: coolifyMatch?.productionStatus ?? "unknown",
          stagingStatus: coolifyMatch?.stagingStatus ?? "unknown",
          deploymentCount: dbSite.environments.reduce((n: number, env: any) => n + env.deployments.length, 0),
          recentActivity,
          siteType: coolifyMatch?.siteType ?? "generic",
          coolifyServiceUuid: dbSite.coolifyServiceUuid ?? undefined,
          gitRepositoryUrl: dbSite.gitRepositoryUrl ?? undefined,
          organizationId: dbSite.organizationId,
          source: "db" as const
        };
      }
    }

    // Fallback: Coolify-only lookup (for sites not yet in DB)
    const site = overview.sites.find((item) => item.id === siteId);
    const client = getClientForCoolifySite(siteId, overview.mode);

    if (!site) return undefined;

    const deploymentCount = overview.deployments.filter((dep) => dep.siteName === site.name).length;

    return {
      id: site.id,
      name: site.name,
      deployTargetId: site.deployTargetId,
      clientId: client?.id ?? "unassigned",
      clientName: client?.name ?? "Unassigned",
      status: site.status,
      productionStatus: site.productionStatus,
      stagingStatus: site.stagingStatus,
      deploymentCount,
      siteType: site.siteType,
      recentActivity: overview.deployments
        .filter((dep) => dep.siteName === site.name)
        .slice(0, 3)
        .map((dep) => `${dep.environment} ${dep.status}`),
      coolifyServiceUuid: site.id,
      source: "coolify" as const
    };
  } catch {
    // Last-resort Coolify fallback
    const overview = await getCoolifyOverview();
    const site = overview.sites.find((item) => item.id === siteId);
    const client = getClientForCoolifySite(siteId, overview.mode);

    if (!site) return undefined;

    return {
      id: site.id,
      name: site.name,
      deployTargetId: site.deployTargetId,
      clientId: client?.id ?? "unassigned",
      clientName: client?.name ?? "Unassigned",
      status: site.status,
      productionStatus: site.productionStatus,
      stagingStatus: site.stagingStatus,
      deploymentCount: overview.deployments.filter((dep) => dep.siteName === site.name).length,
      siteType: site.siteType,
      recentActivity: [],
      source: "coolify" as const
    };
  }
}

export type SiteDeploymentRecord = {
  id: string;
  environment: string;
  status: string;
  triggeredAt: string;
  finishedAt?: string;
  coolifyDeploymentId?: string;
  commitMessage?: string;
  commitSha?: string;
  actor?: string;
  source: "db" | "coolify";
};

export async function listSiteDeployments(siteId: string): Promise<SiteDeploymentRecord[]> {
  try {
    const prisma = await maybeGetDb();

    if (prisma) {
      const rows: any[] = await prisma.deployment.findMany({
        where: {
          environment: {
            siteId,
            site: { deletedAt: null }
          }
        },
        include: {
          environment: { select: { name: true } },
          triggeredBy: { select: { email: true, fullName: true } }
        },
        orderBy: { triggeredAt: "desc" },
        take: 50
      });

      if (rows.length > 0) {
        return rows.map((row: any): SiteDeploymentRecord => ({
          id: row.id,
          environment: row.environment.name,
          status: row.status,
          triggeredAt: row.triggeredAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString(),
          coolifyDeploymentId: row.coolifyDeploymentId ?? undefined,
          commitMessage: row.commitMessage ?? undefined,
          commitSha: row.commitSha ?? undefined,
          actor: row.triggeredBy?.fullName ?? row.triggeredBy?.email ?? undefined,
          source: "db" as const
        }));
      }
    }
  } catch (error) {
    console.error("[jongo] listSiteDeployments: DB query failed, falling back to Coolify data.", error);
  }

  // Fallback: Coolify overview deployments for this site
  try {
    const overview = await getCoolifyOverview();
    const site = overview.sites.find((item) => item.id === siteId);
    if (!site) return [];

    return overview.deployments
      .filter((dep) => dep.siteName === site.name)
      .map((dep): SiteDeploymentRecord => ({
        id: dep.id,
        environment: dep.environment,
        status: dep.status,
        triggeredAt: dep.startedAt ?? dep.finishedAt ?? new Date().toISOString(),
        finishedAt: dep.finishedAt,
        commitMessage: dep.commitMessage ?? undefined,
        source: "coolify" as const
      }));
  } catch {
    return [];
  }
}
