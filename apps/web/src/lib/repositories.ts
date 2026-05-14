import { getClients, getClientById as getMockClientById, getClientForSite, type ClientRecord } from "./clients";
import { getCoolifyOverview } from "./coolify";

export type ClientWorkspaceRecord = ClientRecord & {
  siteCount: number;
  memberCount: number;
};

export type SiteDirectoryRecord = {
  id: string;
  name: string;
  deployTargetId: string;
  clientId: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
};

export type SiteWorkspaceRecord = {
  id: string;
  name: string;
  deployTargetId: string;
  clientId: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  productionStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingStatus: "healthy" | "degraded" | "error" | "unknown";
  deploymentCount: number;
  recentActivity: string[];
  siteType: "wordpress" | "generic";
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
    memberCount: client.members.length
  }));
}

async function maybeGetDb(): Promise<any | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  try {
    const module = await import("./db");
    return module.db;
  } catch {
    return null;
  }
}

export async function getActivityFeed(limit = 6): Promise<ActivityFeedItem[]> {
  const overview = await getCoolifyOverview();
  const deploymentItems: ActivityFeedItem[] = overview.deployments.slice(0, limit).map((deployment) => ({
    id: deployment.id,
    title: `${deployment.siteName} → ${deployment.environment}`,
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
      title: `${site.name} → ${deployment.environment}`,
      detail: deployment.commitMessage ?? `Deployment ${deployment.status}`,
      timestamp: deployment.finishedAt,
      status: deployment.status,
      environment: deployment.environment,
      durationSeconds: deployment.durationSeconds
    }));
}

async function readRealClientWorkspaces(): Promise<ClientWorkspaceRecord[]> {
  const prisma = await maybeGetDb();

  if (!prisma) {
    return fromMockClients();
  }

  const organizations: any[] = await prisma.organization.findMany({
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

export async function listClientWorkspaces(): Promise<ClientWorkspaceRecord[]> {
  try {
    return await readRealClientWorkspaces();
  } catch {
    return fromMockClients();
  }
}

export async function getClientWorkspace(clientId: string): Promise<ClientWorkspaceRecord | undefined> {
  try {
    const prisma = await maybeGetDb();

    if (!prisma) {
      const mockClient = getMockClientById(clientId);

      if (!mockClient) return undefined;

      return {
        ...mockClient,
        siteCount: mockClient.siteIds.length,
        memberCount: mockClient.members.length
      };
    }

    const organization: any = await prisma.organization.findUnique({
      where: { slug: clientId },
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
  } catch {
    const mockClient = getMockClientById(clientId);

    if (!mockClient) return undefined;

    return {
      ...mockClient,
      siteCount: mockClient.siteIds.length,
      memberCount: mockClient.members.length
    };
  }
}

export async function listSiteDirectory(): Promise<SiteDirectoryRecord[]> {
  try {
    const prisma = await maybeGetDb();
    const overview = await getCoolifyOverview();

    if (!prisma) {
      return overview.sites.map((site) => {
        const client = getClientForSite(site.id);

        return {
          id: site.id,
          name: site.name,
          deployTargetId: site.deployTargetId,
          clientId: client?.id ?? "unassigned",
          clientName: client?.name ?? "Unassigned",
          status: site.status
        };
      });
    }

    const organizations: any[] = await prisma.organization.findMany({
      include: { sites: true },
      orderBy: { name: "asc" }
    });

    return overview.sites.map((site) => {
      const owner = organizations.find((organization: any) =>
        organization.sites.some((ownedSite: any) => ownedSite.name === site.name || ownedSite.id === site.id)
      );

      const client = owner ? { id: owner.slug, name: owner.name } : getClientForSite(site.id);

      return {
        id: site.id,
        name: site.name,
        deployTargetId: site.deployTargetId,
        clientId: client?.id ?? "unassigned",
        clientName: client?.name ?? "Unassigned",
        status: site.status
      };
    });
  } catch {
    const overview = await getCoolifyOverview();

    return overview.sites.map((site) => {
      const client = getClientForSite(site.id);

      return {
        id: site.id,
        name: site.name,
        deployTargetId: site.deployTargetId,
        clientId: client?.id ?? "unassigned",
        clientName: client?.name ?? "Unassigned",
        status: site.status
      };
    });
  }
}

export async function getSiteWorkspace(siteId: string): Promise<SiteWorkspaceRecord | undefined> {
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);
  const client = getClientForSite(siteId);

  if (!site) return undefined;

  const deploymentCount = overview.deployments.filter((deployment) => deployment.siteName === site.name).length;

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
      .filter((deployment) => deployment.siteName === site.name)
      .slice(0, 3)
      .map((deployment) => `${deployment.environment} ${deployment.status}`)
  };
}
