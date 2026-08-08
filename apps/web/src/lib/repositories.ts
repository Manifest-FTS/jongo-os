import { getClients, getClientById as getMockClientById, getClientForSite, type ClientRecord } from "./clients";
import { getCoolifyOverview, type CoolifyOverview } from "./coolify";
import { recordRepositoryCall } from "./diagnostics";
import { normalizeRole } from "./roles";

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

function isPrismaSchemaMismatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { code?: string; message?: string; meta?: { message?: string } };
  const message = `${e.message ?? ""} ${e.meta?.message ?? ""}`.toLowerCase();

  return (
    e.code === "P2022" ||
    message.includes("column") && message.includes("does not exist") ||
    message.includes("the column") && message.includes("does not exist")
  );
}

function isPrismaUnknownFieldError(error: unknown, fieldName: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { message?: string; meta?: { message?: string } };
  const message = `${e.message ?? ""} ${e.meta?.message ?? ""}`.toLowerCase();
  return message.includes("unknown field") && message.includes(fieldName.toLowerCase());
}

function isPrismaUnknownArgumentError(error: unknown, fieldName: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { message?: string; meta?: { message?: string } };
  const message = `${e.message ?? ""} ${e.meta?.message ?? ""}`.toLowerCase();
  return message.includes("unknown argument") && message.includes(fieldName.toLowerCase());
}

function isLegacySchemaMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { code?: string; message?: string; meta?: { message?: string } };
  const message = `${e.message ?? ""} ${e.meta?.message ?? ""}`.toLowerCase();

  return (
    message.includes("relation") &&
    (message.includes('"clients" does not exist') ||
      message.includes('"projects" does not exist') ||
      message.includes('"org_members" does not exist') ||
      message.includes('"users" does not exist'))
  );
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

function shouldApplyViewerScope(viewer?: ViewerContext): boolean {
  return Boolean(getScopedViewerUserId(viewer) && !hasBootstrapGlobalAccess(viewer));
}

let hasCheckedTemporaryDomainColumns = false;
let temporaryDomainColumnsAvailable = false;

async function hasTemporaryDomainColumns(prisma: any): Promise<boolean> {
  if (hasCheckedTemporaryDomainColumns) {
    return temporaryDomainColumnsAvailable;
  }

  try {
    const columns = await prisma.$queryRaw<Array<{ columnName: string }>>`
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

function buildSiteIdentityWhere(siteId: string): Record<string, unknown> {
  if (isUuid(siteId)) {
    return {
      OR: [{ id: siteId }, { coolifyServiceUuid: siteId }, { coolifyServiceId: siteId }],
      deletedAt: null
    };
  }

  return {
    slug: siteId,
    deletedAt: null
  };
}

export type ClientWorkspaceRecord = ClientRecord & {
  dbId?: string; // actual DB UUID (undefined when using mock data)
  siteCount: number;
  memberCount: number;
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  linkedCoolifyProjects?: Array<{
    coolifyProjectId: string;
    coolifyProjectName?: string | null;
    isPrimary?: boolean;
  }>;
  /** Where this record was sourced from – "db" means a live Prisma query succeeded. */
  dataSource: "db" | "mock";
};

export type SiteDirectoryRecord = {
  id: string;           // DB UUID when available, Coolify ID otherwise
  slug?: string;
  name: string;
  deployTargetId: string;
  clientId: string;
  clientDbId?: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  ownershipState: "mapped" | "orphaned" | "unavailable";
  ownershipDiagnostic: string;
  source: "db" | "coolify"; // where the record originates
  coolifyServiceUuid?: string;
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  coolifyEnvironmentId?: string;
  coolifyEnvironmentName?: string;
  isStagingResource?: boolean;
  resourceMissingSince?: string;
  description?: string;
    resourceType?: string;
};

export type SiteWorkspaceRecord = {
  id: string;           // DB UUID when available, Coolify ID otherwise
  slug?: string;
  name: string;
  description?: string;
  deployTargetId: string;
  clientId: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  productionStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingEnabled: boolean;
  /** Maintained by the hourly reconciler; true when the resource lives in a staging environment. */
  isStagingResource?: boolean;
  deploymentCount: number;
  recentActivity: string[];
  siteType: "wordpress" | "database" | "service" | "generic";
    resourceType?: string;
  // DB-native fields (only present for DB-backed sites)
  coolifyServiceUuid?: string;
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  coolifyEnvironmentId?: string;
  coolifyEnvironmentName?: string;
  gitRepositoryUrl?: string;
  temporaryDomainSlug?: string;
  temporaryDomainSuffix?: string;
  organizationId?: string;
  ownershipState: "mapped" | "orphaned" | "unavailable";
  ownershipDiagnostic: string;
  source: "db" | "coolify";
};

export type InventoryEmptyReason =
  | "none"
  | "mock_fallback_active"
  | "coolify_api_unavailable"
  | "no_resources_found"
  | "no_db_mappings_yet"
  | "viewer_not_authorized";

export type InventorySnapshot = {
  overview: CoolifyOverview;
  siteDirectory: SiteDirectoryRecord[];
  scopeApplied: boolean;
  bootstrapGlobalAccess: boolean;
  emptyReason: InventoryEmptyReason;
  counts: {
    visibleSites: number;
    coolifySites: number;
    dbMappedVisibleSites: number;
    coolifyVisibleSites: number;
  };
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

function normalizedKey(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function isLikelyStagingEnvironmentName(name?: string): boolean {
  const normalized = normalizedKey(name);
  if (!normalized) {
    return false;
  }

  return normalized.includes("stag") || normalized.includes("preview") || normalized === "dev";
}

function stripStagingAffixes(name: string): string {
  return normalizedKey(name)
    .replace(/^staging[.\-_\s]+/, "")
    .replace(/[.\-_\s]+staging$/, "")
    .trim();
}

function isLikelyStagingSite(site: { name: string; coolifyEnvironmentName?: string | null }): boolean {
  if (isLikelyStagingEnvironmentName(site.coolifyEnvironmentName ?? undefined)) {
    return true;
  }

  const nameKey = normalizedKey(site.name);
  if (!nameKey) {
    return false;
  }

  return /(^|[.\-_\s])(staging|stage|stg|preview|dev)([.\-_\s]|$)/.test(nameKey);
}

function looksLikeDomainName(value?: string | null): boolean {
  const normalized = normalizedKey(value);
  return Boolean(normalized && normalized.includes("."));
}

function scoreDirectoryRecord(record: SiteDirectoryRecord): number {
  let score = 0;

  if (!record.resourceMissingSince) {
    score += 100;
  }

  if (!record.isStagingResource) {
    score += 40;
  }

  if (looksLikeDomainName(record.name)) {
    score += 15;
  }

  if (looksLikeDomainName(record.slug)) {
    score += 10;
  }

  if (record.coolifyProjectId) {
    score += 5;
  }

  return score;
}

function shouldSuppressStagingSiblingRecord(
  site: { name: string; coolifyEnvironmentName?: string; coolifyProjectId?: string },
  dbMappedProjectIds: Set<string>,
  dbNameKeys: Set<string>
): boolean {
  if (!isLikelyStagingEnvironmentName(site.coolifyEnvironmentName)) {
    return false;
  }

  const projectMatched = Boolean(site.coolifyProjectId && dbMappedProjectIds.has(site.coolifyProjectId));
  if (projectMatched) {
    return true;
  }

  const strippedName = stripStagingAffixes(site.name);
  if (!strippedName) {
    return false;
  }

  return dbNameKeys.has(strippedName);
}

type OwnershipOrgRecord = {
  id: string;
  slug: string;
  name: string;
  coolifyProjectId?: string | null;
  coolifyProjectName?: string | null;
  coolifyProjectLinks?: Array<{
    coolifyProjectId: string;
    coolifyProjectName?: string | null;
    isPrimary?: boolean;
  }>;
};

function toSingleMatchOrNull(candidates: OwnershipOrgRecord[]): OwnershipOrgRecord | null {
  if (candidates.length !== 1) {
    return null;
  }

  return candidates[0];
}

function toAppSlug(name: string, fallbackId: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

  if (base.length > 0) {
    return base;
  }

  return fallbackId.trim().toLowerCase();
}

function buildOrganizationOwnershipIndex(organizations: OwnershipOrgRecord[]) {
  const byProjectId = new Map<string, OwnershipOrgRecord[]>();
  const byProjectName = new Map<string, OwnershipOrgRecord[]>();

  const pushUnique = (map: Map<string, OwnershipOrgRecord[]>, key: string, org: OwnershipOrgRecord) => {
    const existing = map.get(key);
    if (!existing) {
      map.set(key, [org]);
      return;
    }

    if (!existing.some((item) => item.id === org.id)) {
      existing.push(org);
    }
  };

  for (const org of organizations) {
    for (const link of org.coolifyProjectLinks ?? []) {
      pushUnique(byProjectId, link.coolifyProjectId, org);

      const linkNameKey = normalizedKey(link.coolifyProjectName);
      if (linkNameKey) {
        pushUnique(byProjectName, linkNameKey, org);
      }
    }

    // Legacy fallback support during migration.
    if (org.coolifyProjectId) {
      pushUnique(byProjectId, org.coolifyProjectId, org);
    }

    const key = normalizedKey(org.coolifyProjectName ?? org.name);
    if (key) {
      pushUnique(byProjectName, key, org);
    }
  }

  return { byProjectId, byProjectName };
}

function mapLegacyProjectStatus(status?: string | null): "healthy" | "degraded" | "error" | "unknown" {
  switch ((status ?? "").trim().toLowerCase()) {
    case "active":
      return "healthy";
    case "on_hold":
      return "degraded";
    case "planning":
      return "unknown";
    default:
      return "unknown";
  }
}

type LegacyClientRow = {
  id: string;
  orgId: string;
  name: string;
  email?: string | null;
  status?: string | null;
  notes?: string | null;
  userId?: string | null;
};

type LegacyProjectRow = {
  id: string;
  clientId?: string | null;
  orgId?: string | null;
  name: string;
  description?: string | null;
  status?: string | null;
};

type LegacyMemberRow = {
  id: string;
  userId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: string;
};

function formatLegacyMemberName(member: LegacyMemberRow): string {
  const fullName = [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
  return fullName || member.email;
}

async function readLegacyClients(prisma: any, viewer?: ViewerContext): Promise<LegacyClientRow[]> {
  const scopedUserId = getScopedViewerUserId(viewer);
  const useScope = scopedUserId && !hasBootstrapGlobalAccess(viewer);

  if (useScope) {
    return prisma.$queryRaw`
      select
        c.id as "id",
        c.org_id as "orgId",
        c.name as "name",
        c.email as "email",
        c.status as "status",
        c.notes as "notes",
        c.user_id as "userId"
      from clients c
      where c.user_id::text = ${scopedUserId}
         or exists (
           select 1
           from org_members m
           where m.org_id::text = c.org_id::text
             and m.user_id::text = ${scopedUserId}
         )
      order by c.created_at asc
    `;
  }

  return prisma.$queryRaw`
    select
      c.id as "id",
      c.org_id as "orgId",
      c.name as "name",
      c.email as "email",
      c.status as "status",
      c.notes as "notes",
      c.user_id as "userId"
    from clients c
    order by c.created_at asc
  `;
}

async function readLegacyClientProjects(prisma: any, clientId: string): Promise<LegacyProjectRow[]> {
  return prisma.$queryRaw`
    select
      p.id as "id",
      p.client_id as "clientId",
      p.org_id as "orgId",
      p.name as "name",
      p.description as "description",
      p.status::text as "status"
    from projects p
    where p.client_id::text = ${clientId}
    order by p.created_at asc
  `;
}

async function readLegacySiteDirectory(prisma: any, viewer?: ViewerContext): Promise<SiteDirectoryRecord[]> {
  const scopedUserId = getScopedViewerUserId(viewer);
  const useScope = scopedUserId && !hasBootstrapGlobalAccess(viewer);

  const rows: Array<{
    id: string;
    name: string;
    description: string | null;
    status: string | null;
    clientId: string | null;
    orgId: string | null;
    clientName: string | null;
  }> = useScope
    ? await prisma.$queryRaw`
      select
        p.id as "id",
        p.name as "name",
        p.description as "description",
        p.status::text as "status",
        p.client_id as "clientId",
        p.org_id as "orgId",
        c.name as "clientName"
      from projects p
      left join clients c on c.id::text = p.client_id::text
      where c.user_id::text = ${scopedUserId}
         or exists (
           select 1
           from org_members m
           where m.org_id::text = c.org_id::text
             and m.user_id::text = ${scopedUserId}
         )
      order by p.created_at asc
    `
    : await prisma.$queryRaw`
      select
        p.id as "id",
        p.name as "name",
        p.description as "description",
        p.status::text as "status",
        p.client_id as "clientId",
        p.org_id as "orgId",
        c.name as "clientName"
      from projects p
      left join clients c on c.id::text = p.client_id::text
      order by p.created_at asc
    `;

  return rows.map((row) => ({
    id: row.id,
    slug: toAppSlug(row.name, row.id),
    name: row.name,
    description: row.description ?? undefined,
    deployTargetId: row.id,
    clientId: row.clientId ?? row.orgId ?? "orphaned",
    clientName: row.clientName ?? "Client",
    status: mapLegacyProjectStatus(row.status),
    ownershipState: row.clientId || row.orgId ? "mapped" : "orphaned",
    ownershipDiagnostic: row.clientName
      ? `Client: ${row.clientName}`
      : "No client mapping found",
    source: "db"
  }));
}

async function readLegacyClientMembers(prisma: any, clientRow: LegacyClientRow): Promise<LegacyMemberRow[]> {
  const orgMembers: LegacyMemberRow[] = await prisma.$queryRaw`
    select
      m.id as "id",
      m.user_id as "userId",
      u.email as "email",
      u.first_name as "firstName",
      u.last_name as "lastName",
      m.role::text as "role"
    from org_members m
    join users u on u.id = m.user_id
    where m.org_id::text = ${clientRow.orgId}
    order by m.created_at asc
  `;

  const ownerRows: LegacyMemberRow[] = clientRow.userId
    ? await prisma.$queryRaw`
      select
        u.id as "id",
        u.id as "userId",
        u.email as "email",
        u.first_name as "firstName",
        u.last_name as "lastName",
        'admin' as "role"
      from users u
      where u.id::text = ${clientRow.userId}
    `
    : [];

  const merged = new Map<string, LegacyMemberRow>();
  for (const member of [...ownerRows, ...orgMembers]) {
    merged.set(member.userId, member);
  }

  return [...merged.values()];
}

function buildClientWorkspaceFromLegacy(
  clientRow: LegacyClientRow,
  projects: LegacyProjectRow[],
  members: LegacyMemberRow[]
): ClientWorkspaceRecord {
  return {
    id: clientRow.id,
    dbId: clientRow.id,
    dataSource: "db" as const,
    name: clientRow.name,
    summary: clientRow.notes ?? clientRow.status ?? "Client workspace",
    siteIds: projects.map((project) => project.id),
    members: members.map((member) => ({
      name: formatLegacyMemberName(member),
      role: normalizeRole(member.role)
    })),
    recentActivity: projects.slice(-3).map((project) => `${project.name} ${project.status ?? "unknown"}`),
    siteCount: projects.length,
    memberCount: members.length,
    coolifyProjectId: undefined,
    coolifyProjectName: undefined,
    linkedCoolifyProjects: []
  };
}

function buildClientWorkspaceFromPrismaOrganization(org: any): ClientWorkspaceRecord {
  const collaboratorMembers = (org.collaborators ?? []).map((c: any) => ({
    userId: c.user?.id,
    name: c.user?.fullName || c.user?.email || "Unknown",
    role: normalizeRole(c.role),
    email: c.user?.email
  }));

  const ownerMember = {
    userId: org.owner?.id,
    name: org.owner?.fullName || org.owner?.email || "Owner",
    role: "admin" as const,
    email: org.owner?.email
  };

  const memberByUserId = new Map<string, { userId?: string; name: string; role: string; email?: string }>();
  if (ownerMember.userId) {
    memberByUserId.set(ownerMember.userId, ownerMember);
  }
  for (const member of collaboratorMembers) {
    if (!member.userId) continue;
    memberByUserId.set(member.userId, member);
  }

  const sites = org.sites ?? [];
  const linkMappings = [...(org.coolifyProjectLinks ?? [])]
    .sort((a: any, b: any) => {
      if (Boolean(a.isPrimary) !== Boolean(b.isPrimary)) {
        return a.isPrimary ? -1 : 1;
      }

      return 0;
    });
  const primaryMapping = linkMappings[0];

  return {
    id: org.slug,
    dbId: org.id,
    dataSource: "db",
    name: org.name,
    summary: org.description ?? "Client workspace",
    siteIds: sites.map((site: any) => site.id),
    members: [...memberByUserId.values()].map((member) => ({
      name: member.name,
      role: normalizeRole(member.role)
    })),
    recentActivity: sites.slice(-3).map((site: any) => `${site.name} active`),
    siteCount: sites.length,
    memberCount: memberByUserId.size,
    coolifyProjectId: primaryMapping?.coolifyProjectId ?? org.coolifyProjectId ?? undefined,
    coolifyProjectName: primaryMapping?.coolifyProjectName ?? org.coolifyProjectName ?? undefined,
    linkedCoolifyProjects: linkMappings.length > 0
      ? linkMappings.map((link: any) => ({
          coolifyProjectId: link.coolifyProjectId,
          coolifyProjectName: link.coolifyProjectName,
          isPrimary: Boolean(link.isPrimary)
        }))
      : org.coolifyProjectId
        ? [
            {
              coolifyProjectId: org.coolifyProjectId,
              coolifyProjectName: org.coolifyProjectName,
              isPrimary: true
            }
          ]
        : []
  };
}

function resolveOwnershipForCoolifySite(
  site: { id: string; coolifyProjectId?: string; coolifyProjectName?: string },
  mode: "live" | "mock",
  index?: { byProjectId: Map<string, OwnershipOrgRecord[]>; byProjectName: Map<string, OwnershipOrgRecord[]> }
): {
  clientId: string;
  clientDbId?: string;
  clientName: string;
  ownershipState: "mapped" | "orphaned" | "unavailable";
  ownershipDiagnostic: string;
} {
  if (mode === "mock") {
    const mockClient = getClientForSite(site.id);
    if (mockClient) {
      return {
        clientId: mockClient.id,
        clientDbId: undefined,
        clientName: mockClient.name,
        ownershipState: "mapped",
        ownershipDiagnostic: `Client: ${mockClient.name}`
      };
    }
  }

  if (index) {
    if (site.coolifyProjectId && index.byProjectId.has(site.coolifyProjectId)) {
      const org = toSingleMatchOrNull(index.byProjectId.get(site.coolifyProjectId) ?? []);
      if (org) {
        return {
          clientId: org.slug,
          clientDbId: org.id,
          clientName: org.name,
          ownershipState: "mapped",
          ownershipDiagnostic: `Client: ${org.name}`
        };
      }

      return {
        clientId: "orphaned",
        clientName: "Unmapped Client",
        ownershipState: "orphaned",
        ownershipDiagnostic: "Project linked to multiple clients; manual app-level mapping required"
      };
    }

    const projectNameKey = normalizedKey(site.coolifyProjectName);
    if (projectNameKey && index.byProjectName.has(projectNameKey)) {
      const org = toSingleMatchOrNull(index.byProjectName.get(projectNameKey) ?? []);
      if (org) {
        return {
          clientId: org.slug,
          clientDbId: org.id,
          clientName: org.name,
          ownershipState: "mapped",
          ownershipDiagnostic: `Client: ${org.name}`
        };
      }

      return {
        clientId: "orphaned",
        clientName: "Unmapped Client",
        ownershipState: "orphaned",
        ownershipDiagnostic: "Project name linked to multiple clients; manual app-level mapping required"
      };
    }
  }

  const fallbackProject = site.coolifyProjectName ?? site.coolifyProjectId;
  if (fallbackProject) {
    return {
      clientId: "orphaned",
      clientName: "Unmapped Client",
      ownershipState: "orphaned",
      ownershipDiagnostic: "Project found but no Jongo Client mapped"
    };
  }

  return {
    clientId: "orphaned",
    clientName: "Unknown Client",
    ownershipState: "unavailable",
    ownershipDiagnostic: "Coolify project unavailable from API"
  };
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

let legacySchemaAvailableCache: boolean | undefined;

async function hasLegacySchema(prisma: any): Promise<boolean> {
  if (legacySchemaAvailableCache !== undefined) {
    return legacySchemaAvailableCache;
  }

  try {
    const rows: Array<{ tableName: string }> = await prisma.$queryRaw`
      select table_name as "tableName"
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('clients', 'projects', 'org_members', 'users')
    `;

    const available = new Set(rows.map((row) => row.tableName));
    legacySchemaAvailableCache =
      available.has("clients") &&
      available.has("projects") &&
      available.has("org_members") &&
      available.has("users");
    return legacySchemaAvailableCache;
  } catch {
    legacySchemaAvailableCache = false;
    return false;
  }
}

export async function getActivityFeed(limit = 6, viewer?: ViewerContext): Promise<ActivityFeedItem[]> {
  const overview = await getCoolifyOverview();
  const visibleSites = await listSiteDirectory(viewer, overview);
  const visibleNames = new Set(visibleSites.map((site) => normalizedKey(site.name)));
  const scopeApplied = shouldApplyViewerScope(viewer);

  const deploymentItems: ActivityFeedItem[] = overview.deployments
    .filter((deployment) => !scopeApplied || visibleNames.has(normalizedKey(deployment.siteName)))
    .slice(0, limit)
    .map((deployment) => ({
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

export async function getSiteActivityFeed(siteId: string, limit = 6, viewer?: ViewerContext): Promise<ActivityFeedItem[]> {
  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace) {
    return [];
  }

  const overview = await getCoolifyOverview();
  const prisma = await maybeGetDb();
  let dbSite: { coolifyServiceUuid: string | null; name: string } | null = null;

  if (prisma) {
    try {
      dbSite = await prisma.site.findFirst({
        where: buildSiteIdentityWhere(siteId),
        select: { coolifyServiceUuid: true, name: true }
      });
    } catch (error) {
      if (!isPrismaUuidMismatchError(error)) {
        console.error("[jongo] getSiteActivityFeed: DB site lookup failed, falling back to overview-only activity.", error);
      }
    }
  }

  const coolifyId = dbSite?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find(
    (item) =>
      item.id === coolifyId ||
      item.deployTargetId === coolifyId ||
      toAppSlug(item.name, item.id) === siteId ||
      (dbSite?.name ? toAppSlug(item.name, item.id) === toAppSlug(dbSite.name, item.id) : false)
  );

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
    return shouldApplyViewerScope(viewer) ? [] : fromMockClients();
  }

  const scopedUserId = getScopedViewerUserId(viewer);
  const readPrismaOrganizations = async () => {
    const where: any = { deletedAt: null };
    if (scopedUserId && !hasBootstrapGlobalAccess(viewer)) {
      where.OR = [
        { ownerId: scopedUserId },
        { collaborators: { some: { userId: scopedUserId, deletedAt: null } } }
      ];
    }

    let orgs: any[];
    try {
      orgs = await prisma.organization.findMany({
        where,
        include: {
          owner: { select: { id: true, email: true, fullName: true } },
          collaborators: {
            where: { deletedAt: null },
            include: { user: { select: { id: true, email: true, fullName: true } } }
          },
          sites: { where: { deletedAt: null }, select: { id: true, name: true } },
          coolifyProjectLinks: {
            select: { coolifyProjectId: true, coolifyProjectName: true, isPrimary: true },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        },
        orderBy: { createdAt: "asc" }
      });
    } catch (error) {
      if (!isPrismaUnknownFieldError(error, "coolifyProjectLinks")) {
        throw error;
      }

      orgs = await prisma.organization.findMany({
        where,
        include: {
          owner: { select: { id: true, email: true, fullName: true } },
          collaborators: {
            where: { deletedAt: null },
            include: { user: { select: { id: true, email: true, fullName: true } } }
          },
          sites: { where: { deletedAt: null }, select: { id: true, name: true } }
        },
        orderBy: { createdAt: "asc" }
      });
    }

    return orgs.map((org: any) => buildClientWorkspaceFromPrismaOrganization(org));
  };

  if (!(await hasLegacySchema(prisma))) {
    return readPrismaOrganizations();
  }

  try {
    const clients = await readLegacyClients(prisma, viewer);
    const workspaces = await Promise.all(
      clients.map(async (clientRow) => {
        const [projects, members] = await Promise.all([
          readLegacyClientProjects(prisma, clientRow.id),
          readLegacyClientMembers(prisma, clientRow)
        ]);

        return buildClientWorkspaceFromLegacy(clientRow, projects, members);
      })
    );

    return workspaces;
  } catch (error) {
    if (!isLegacySchemaMissingError(error)) {
      throw error;
    }

    return readPrismaOrganizations();
  }
}

export async function listClientWorkspaces(viewer?: ViewerContext): Promise<ClientWorkspaceRecord[]> {
  const scopedUserId = getScopedViewerUserId(viewer);
  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(viewer);
  const scopeApplied = Boolean(scopedUserId && !bootstrapGlobalAccess);

  try {
    const rows = await readRealClientWorkspaces(viewer);
    const mockCount = rows.filter((row) => row.dataSource === "mock").length;
    const dbCount = rows.filter((row) => row.dataSource === "db").length;
    const source = mockCount > 0 ? "mock" : "db";

    recordRepositoryCall({
      operation: "listClientWorkspaces",
      source,
      recordCount: rows.length,
      dbCount,
      coolifyCount: 0,
      mockCount,
      scopeApplied,
      viewerUserIdPresent: Boolean(viewer?.userId),
      viewerUserIdIsUuid: Boolean(scopedUserId),
      bootstrapGlobalAccess,
      fallbackUsed: mockCount > 0,
      note:
        source === "mock"
          ? process.env.DATABASE_URL
            ? "mock_data_returned_with_database_configured"
            : "mock_data_returned_without_database"
          : "db_query_succeeded"
    });

    return rows;
  } catch (error) {
    if (isPrismaSchemaMismatchError(error)) {
      console.error(
        "[jongo] listClientWorkspaces: Prisma schema mismatch detected. Migration required before DB data can be read.",
        "Run: npx prisma migrate deploy --schema .\\prisma\\schema.prisma",
        "Error:", error
      );
    }

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

    const fallbackRows = scopeApplied ? [] : fromMockClients();

    recordRepositoryCall({
      operation: "listClientWorkspaces",
      source: "mock",
      recordCount: fallbackRows.length,
      dbCount: 0,
      coolifyCount: 0,
      mockCount: fallbackRows.length,
      scopeApplied,
      viewerUserIdPresent: Boolean(viewer?.userId),
      viewerUserIdIsUuid: Boolean(scopedUserId),
      bootstrapGlobalAccess,
      fallbackUsed: true,
      note: "exception_triggered_mock_fallback"
    });

    return fallbackRows;
  }
}

export async function getClientWorkspace(clientId: string, viewer?: ViewerContext): Promise<ClientWorkspaceRecord | undefined> {
  try {
    const prisma = await maybeGetDb();

    if (!prisma) {
      if (shouldApplyViewerScope(viewer)) {
        return undefined;
      }

      const mockClient = getMockClientById(clientId);

      if (!mockClient) return undefined;

      return {
        ...mockClient,
        siteCount: mockClient.siteIds.length,
        memberCount: mockClient.members.length,
        dataSource: "mock" as const
      };
    }

    const scopedUserId = getScopedViewerUserId(viewer);
    const readPrismaOrganization = async () => {
      const identityFilter = isUuid(clientId)
        ? { OR: [{ id: clientId }, { slug: clientId }] }
        : { slug: clientId };

      const where: any = {
        deletedAt: null,
        ...identityFilter
      };

      if (scopedUserId && !hasBootstrapGlobalAccess(viewer)) {
        where.AND = [
          {
            OR: [
              { ownerId: scopedUserId },
              { collaborators: { some: { userId: scopedUserId, deletedAt: null } } }
            ]
          }
        ];
      }

      let org: any;
      try {
        org = await prisma.organization.findFirst({
          where,
          include: {
            owner: { select: { id: true, email: true, fullName: true } },
            collaborators: {
              where: { deletedAt: null },
              include: { user: { select: { id: true, email: true, fullName: true } } }
            },
            sites: { where: { deletedAt: null }, select: { id: true, name: true } },
            coolifyProjectLinks: {
              select: { coolifyProjectId: true, coolifyProjectName: true, isPrimary: true },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
            }
          }
        });
      } catch (error) {
        if (!isPrismaUnknownFieldError(error, "coolifyProjectLinks")) {
          throw error;
        }

        org = await prisma.organization.findFirst({
          where,
          include: {
            owner: { select: { id: true, email: true, fullName: true } },
            collaborators: {
              where: { deletedAt: null },
              include: { user: { select: { id: true, email: true, fullName: true } } }
            },
            sites: { where: { deletedAt: null }, select: { id: true, name: true } }
          }
        });
      }

      if (!org) {
        return undefined;
      }

      return buildClientWorkspaceFromPrismaOrganization(org);
    };

    if (!(await hasLegacySchema(prisma))) {
      return readPrismaOrganization();
    }

    try {
      const clientRows: LegacyClientRow[] = scopedUserId && !hasBootstrapGlobalAccess(viewer)
        ? await prisma.$queryRaw`
        select
          c.id as "id",
          c.org_id as "orgId",
          c.name as "name",
          c.email as "email",
          c.status as "status",
          c.notes as "notes",
          c.user_id as "userId"
        from clients c
        where c.id::text = ${clientId}
          and (
            c.user_id::text = ${scopedUserId}
            or exists (
              select 1
              from org_members m
              where m.org_id::text = c.org_id::text
                and m.user_id::text = ${scopedUserId}
            )
          )
        limit 1
      `
      : await prisma.$queryRaw`
        select
          c.id as "id",
          c.org_id as "orgId",
          c.name as "name",
          c.email as "email",
          c.status as "status",
          c.notes as "notes",
          c.user_id as "userId"
        from clients c
        where c.id::text = ${clientId}
        limit 1
      `;

      const clientRow = clientRows[0];
      if (!clientRow) return undefined;

      const [projects, members] = await Promise.all([
        readLegacyClientProjects(prisma, clientRow.id),
        readLegacyClientMembers(prisma, clientRow)
      ]);

      return buildClientWorkspaceFromLegacy(clientRow, projects, members);
    } catch (error) {
      if (!isLegacySchemaMissingError(error)) {
        throw error;
      }
      return readPrismaOrganization();
    }
  } catch (error) {
    if (isPrismaSchemaMismatchError(error)) {
      console.error(
        "[jongo] getClientWorkspace: Prisma schema mismatch detected. Migration required before DB data can be read.",
        "Run: npx prisma migrate deploy --schema .\\prisma\\schema.prisma",
        "Error:", error
      );
    }

    console.error(
      "[jongo] getClientWorkspace: DB query failed, falling back to mock data.",
      "DATABASE_URL present:", !!process.env.DATABASE_URL,
      "Error:", error
    );
    if (shouldApplyViewerScope(viewer)) {
      return undefined;
    }

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

export type ClientTeamMemberRecord = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
};

export async function getClientTeamMembers(clientDbId: string): Promise<ClientTeamMemberRecord[]> {
  const prisma = await maybeGetDb();

  if (!prisma) {
    return [];
  }

  const readPrismaMembers = async () => {
    const org = await prisma.organization.findUnique({
      where: { id: clientDbId },
      include: {
        owner: { select: { id: true, email: true, fullName: true } },
        collaborators: {
          where: { deletedAt: null },
          include: { user: { select: { id: true, email: true, fullName: true } } }
        }
      }
    });

    if (!org) {
      return [];
    }

    const members = new Map<string, ClientTeamMemberRecord>();
    if (org.owner?.id) {
      members.set(org.owner.id, {
        id: org.owner.id,
        userId: org.owner.id,
        name: org.owner.fullName || org.owner.email,
        email: org.owner.email,
        role: "admin"
      });
    }

    for (const collaborator of org.collaborators ?? []) {
      if (!collaborator.user?.id) continue;
      members.set(collaborator.user.id, {
        id: collaborator.id,
        userId: collaborator.user.id,
        name: collaborator.user.fullName || collaborator.user.email,
        email: collaborator.user.email,
        role: normalizeRole(collaborator.role)
      });
    }

    return [...members.values()];
  };

  if (!(await hasLegacySchema(prisma))) {
    return readPrismaMembers();
  }

  try {
    const clientRows: Array<{ orgId: string; userId: string | null }> = await prisma.$queryRaw`
      select c.org_id as "orgId", c.user_id as "userId"
      from clients c
      where c.id::text = ${clientDbId}
      limit 1
    `;

    const clientRow = clientRows[0];
    if (!clientRow) {
      return [];
    }

    const rows: LegacyMemberRow[] = await readLegacyClientMembers(prisma, {
      id: clientDbId,
      orgId: clientRow.orgId,
      name: "",
      userId: clientRow.userId
    });

    return rows.map((member) => ({
      id: member.id,
      userId: member.userId,
      name: formatLegacyMemberName(member),
      email: member.email,
      role: normalizeRole(member.role)
    }));
  } catch (error) {
    if (!isLegacySchemaMissingError(error)) {
      throw error;
    }
    return readPrismaMembers();
  }
}

export async function isClientAdmin(clientDbId: string, userId: string): Promise<boolean> {
  const prisma = await maybeGetDb();

  if (!prisma) {
    return false;
  }

  const readPrismaAdminState = async () => {
    const org = await prisma.organization.findUnique({
      where: { id: clientDbId },
      select: {
        ownerId: true,
        collaborators: {
          where: { userId, deletedAt: null },
          select: { role: true },
          take: 1
        }
      }
    });

    if (!org) {
      return false;
    }

    return org.ownerId === userId || normalizeRole(org.collaborators[0]?.role) === "admin";
  };

  if (!(await hasLegacySchema(prisma))) {
    return readPrismaAdminState();
  }

  try {
    const rows: Array<{ isOwner: boolean; memberRole: string | null }> = await prisma.$queryRaw`
      select
        (c.user_id::text = ${userId}) as "isOwner",
        m.role::text as "memberRole"
      from clients c
      left join org_members m
        on m.org_id::text = c.org_id::text
       and m.user_id::text = ${userId}
      where c.id::text = ${clientDbId}
      limit 1
    `;

    const row = rows[0];
    if (!row) {
      return false;
    }

    return row.isOwner || normalizeRole(row.memberRole) === "admin";
  } catch (error) {
    if (!isLegacySchemaMissingError(error)) {
      throw error;
    }
    return readPrismaAdminState();
  }
}

export async function listSiteDirectory(viewer?: ViewerContext, preloadedOverview?: CoolifyOverview): Promise<SiteDirectoryRecord[]> {
  const scopedUserId = getScopedViewerUserId(viewer);
  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(viewer);
  const scopeApplied = Boolean(scopedUserId && !bootstrapGlobalAccess);
  let overview = preloadedOverview;

  const recordSiteDirectoryDiagnostics = (records: SiteDirectoryRecord[], fallbackUsed: boolean, note: string) => {
    const dbCount = records.filter((record) => record.source === "db").length;
    const coolifyCount = records.filter((record) => record.source === "coolify").length;

    let source: "db" | "coolify" | "hybrid" | "mock" = "coolify";
    if (dbCount > 0 && coolifyCount > 0) {
      source = "hybrid";
    } else if (dbCount > 0) {
      source = "db";
    } else if (coolifyCount > 0) {
      source = "coolify";
    }

    recordRepositoryCall({
      operation: "listSiteDirectory",
      source,
      recordCount: records.length,
      dbCount,
      coolifyCount,
      mockCount: 0,
      scopeApplied,
      viewerUserIdPresent: Boolean(viewer?.userId),
      viewerUserIdIsUuid: Boolean(scopedUserId),
      bootstrapGlobalAccess,
      fallbackUsed,
      note
    });
  };

  try {
    const prisma = await maybeGetDb();
    overview = overview ?? (await getCoolifyOverview());
    const resolvedOverview = overview;

    if (!resolvedOverview) {
      throw new Error("inventory_overview_unavailable");
    }

    if (!prisma) {
      if (scopeApplied) {
        recordSiteDirectoryDiagnostics([], true, "db_unavailable_scoped_empty");
        return [];
      }

      const records = resolvedOverview.sites
        .filter((site) => !isLikelyStagingSite(site))
        .map((site) => {
        const ownership = resolveOwnershipForCoolifySite(site, resolvedOverview.mode);
        return {
          id: site.id,
          slug: toAppSlug(site.name, site.id),
          name: site.name,
          deployTargetId: site.deployTargetId,
          clientId: ownership.clientId,
          clientDbId: ownership.clientDbId,
          clientName: ownership.clientName,
          status: site.status,
          ownershipState: ownership.ownershipState,
          ownershipDiagnostic: ownership.ownershipDiagnostic,
          source: "coolify" as const,
          coolifyProjectId: site.coolifyProjectId,
          coolifyProjectName: site.coolifyProjectName,
          coolifyEnvironmentId: site.coolifyEnvironmentId,
          coolifyEnvironmentName: site.coolifyEnvironmentName,
          isStagingResource: false
        };
      });

      recordSiteDirectoryDiagnostics(records, true, "db_unavailable_coolify_only");
      return records;
    }

    // --- DB sites (user-scoped) ---
    const orgWhere: any = { deletedAt: null };
    // Standalone databases that belong inside an app are nested there by the
    // reconciler and must not also appear as peer apps in the directory.
    const siteWhereBase: any = { deletedAt: null };
    if (scopeApplied && scopedUserId) {
      orgWhere.OR = [
        { ownerId: scopedUserId },
        { collaborators: { some: { userId: scopedUserId, deletedAt: null } } }
      ];
      siteWhereBase.OR = [
        { organization: orgWhere },
        { collaborators: { some: { userId: scopedUserId, deletedAt: null } } }
      ];
    }

    try {
      let hasParentSiteIdFilter = true;
      let hasIsStagingResourceField = true;
      let hasResourceMissingSinceField = true;

      const readDbSites = async () => {
        const siteWhere: any = { ...siteWhereBase };
        if (hasParentSiteIdFilter) {
          siteWhere.parentSiteId = null;
        }
        if (hasIsStagingResourceField) {
          siteWhere.isStagingResource = false;
        }

        const select: any = {
          id: true,
          organizationId: true,
          slug: true,
          name: true,
          description: true,
          coolifyServiceUuid: true,
          coolifyProjectId: true,
          organization: { select: { id: true, slug: true, name: true } }
        };
        if (hasIsStagingResourceField) {
          select.isStagingResource = true;
        }
        if (hasResourceMissingSinceField) {
          select.resourceMissingSince = true;
        }

        return prisma.site.findMany({
          where: siteWhere,
          select,
          orderBy: { name: "asc" }
        });
      };

      let dbSites: any[];
      try {
        dbSites = await readDbSites();
      } catch (error) {
        const parentUnsupported = isPrismaUnknownArgumentError(error, "parentSiteId");
        const stagingUnsupported =
          isPrismaUnknownArgumentError(error, "isStagingResource") ||
          isPrismaUnknownFieldError(error, "isStagingResource");
        const missingSinceUnsupported = isPrismaUnknownFieldError(error, "resourceMissingSince");

        if (!parentUnsupported && !stagingUnsupported && !missingSinceUnsupported) {
          throw error;
        }

        hasParentSiteIdFilter = !parentUnsupported;
        hasIsStagingResourceField = !stagingUnsupported;
        hasResourceMissingSinceField = !missingSinceUnsupported;
        dbSites = await readDbSites();
      }

      let visibleOrganizations: any[];
      try {
        visibleOrganizations = await prisma.organization.findMany({
          where: orgWhere,
          select: {
            id: true,
            slug: true,
            name: true,
            coolifyProjectId: true,
            coolifyProjectName: true,
            coolifyProjectLinks: {
              select: { coolifyProjectId: true, coolifyProjectName: true, isPrimary: true }
            }
          }
        });
      } catch (error) {
        if (!isPrismaUnknownFieldError(error, "coolifyProjectLinks")) {
          throw error;
        }

        visibleOrganizations = await prisma.organization.findMany({
          where: orgWhere,
          select: {
            id: true,
            slug: true,
            name: true,
            coolifyProjectId: true,
            coolifyProjectName: true
          }
        });
      }
      const ownershipIndex = buildOrganizationOwnershipIndex(visibleOrganizations);

      // Track which Coolify UUIDs are already represented by DB records
      const coveredCoolifyUuids = new Set(
        dbSites.map((s: any) => s.coolifyServiceUuid).filter(Boolean)
      );

      const dbRecords: SiteDirectoryRecord[] = dbSites.map((s: any) => {
        const coolifyMatch = s.coolifyServiceUuid
          ? resolvedOverview.sites.find((cs) => cs.deployTargetId === s.coolifyServiceUuid || cs.id === s.coolifyServiceUuid)
          : undefined;
        const isStagingRecord = hasIsStagingResourceField
          ? Boolean(s.isStagingResource)
          : isLikelyStagingSite({
              name: s.name,
              coolifyEnvironmentName: coolifyMatch?.coolifyEnvironmentName ?? undefined
            });

        return {
          id: s.id,
          slug: s.slug ?? toAppSlug(s.name, s.id),
          name: s.name,
          description: s.description ?? undefined,
          deployTargetId: coolifyMatch?.deployTargetId ?? s.coolifyServiceUuid ?? "",
          clientId: s.organization.slug,
          clientDbId: s.organization.id,
          clientName: s.organization.name,
          status: coolifyMatch?.status ?? "unknown",
          ownershipState: "mapped" as const,
          ownershipDiagnostic: `Client: ${s.organization.name}`,
          source: "db" as const,
          coolifyServiceUuid: s.coolifyServiceUuid ?? undefined,
          coolifyProjectId: s.coolifyProjectId ?? coolifyMatch?.coolifyProjectId,
          coolifyProjectName: coolifyMatch?.coolifyProjectName,
          coolifyEnvironmentId: coolifyMatch?.coolifyEnvironmentId,
          coolifyEnvironmentName: coolifyMatch?.coolifyEnvironmentName,
          isStagingResource: isStagingRecord,
          resourceMissingSince: s.resourceMissingSince ? new Date(s.resourceMissingSince).toISOString() : undefined,
          resourceType: coolifyMatch?.resourceType
        };
      }).filter((record) => {
        if (record.resourceMissingSince) {
          return false;
        }

        if (record.isStagingResource) {
          return false;
        }

        if (!hasParentSiteIdFilter && record.resourceType === "Database") {
          return false;
        }

        return true;
      });

      const dbMappedProjectIds = new Set(
        dbRecords
          .map((record) => record.coolifyProjectId)
          .filter((value): value is string => Boolean(value))
      );
      const dbNameKeys = new Set(dbRecords.map((record) => normalizedKey(record.name)).filter(Boolean));

      // --- Coolify-only sites (not linked to any DB record) ---
      const coolifyOnlyRecords: SiteDirectoryRecord[] = resolvedOverview.sites
        .filter((cs) => !isLikelyStagingSite(cs))
        .filter((cs) => !coveredCoolifyUuids.has(cs.id) && !coveredCoolifyUuids.has(cs.deployTargetId))
        .filter((cs) => !shouldSuppressStagingSiblingRecord(cs, dbMappedProjectIds, dbNameKeys))
        .map((site) => {
          const ownership = resolveOwnershipForCoolifySite(site, resolvedOverview.mode, ownershipIndex);
          return {
            id: site.id,
            slug: toAppSlug(site.name, site.id),
            name: site.name,
            deployTargetId: site.deployTargetId,
            clientId: ownership.clientId,
            clientDbId: ownership.clientDbId,
            clientName: ownership.clientName,
            status: site.status,
            ownershipState: ownership.ownershipState,
            ownershipDiagnostic: ownership.ownershipDiagnostic,
            source: "coolify" as const,
            coolifyServiceUuid: site.id,
            coolifyProjectId: site.coolifyProjectId,
            coolifyProjectName: site.coolifyProjectName,
            coolifyEnvironmentId: site.coolifyEnvironmentId,
            coolifyEnvironmentName: site.coolifyEnvironmentName,
            isStagingResource: false,
            resourceType: site.resourceType
          };
        })
        .filter((record) => !scopeApplied || record.ownershipState === "mapped");

      const dedupeKey = (record: SiteDirectoryRecord): string => {
        const uuidKey = normalizedKey(record.coolifyServiceUuid || record.deployTargetId || record.id);
        if (uuidKey) {
          return `uuid:${uuidKey}`;
        }

        const orgKey = normalizedKey(record.clientDbId || record.clientId);
        const nameKey = normalizedKey(record.name);
        const envKey = normalizedKey(record.coolifyEnvironmentName || record.coolifyEnvironmentId);
        return `name:${orgKey}:${nameKey}:${envKey}`;
      };

      const mergedByKey = new Map<string, SiteDirectoryRecord>();
      for (const record of [...dbRecords, ...coolifyOnlyRecords]) {
        const key = dedupeKey(record);
        const existing = mergedByKey.get(key);
        if (!existing) {
          mergedByKey.set(key, record);
          continue;
        }

        // Prefer DB-backed records when duplicates represent the same app.
        if (existing.source === "coolify" && record.source === "db") {
          mergedByKey.set(key, record);
          continue;
        }

        if (existing.source === record.source && scoreDirectoryRecord(record) > scoreDirectoryRecord(existing)) {
          mergedByKey.set(key, record);
        }
      }

      const mergedRecords = [...mergedByKey.values()];
      recordSiteDirectoryDiagnostics(mergedRecords, false, "db_plus_coolify_merge");
      return mergedRecords;
    } catch (siteQueryError) {
      const legacyRecords = (await hasLegacySchema(prisma))
        ? await readLegacySiteDirectory(prisma, viewer)
        : [];
      const legacyNames = new Set(legacyRecords.map((record) => normalizedKey(record.name)));
      const coolifyRecords: SiteDirectoryRecord[] = scopeApplied
        ? []
        : resolvedOverview.sites
            .filter((site) => !isLikelyStagingSite(site))
            .filter((site) => !legacyNames.has(normalizedKey(site.name)))
            .map((site) => {
              const ownership = resolveOwnershipForCoolifySite(site, resolvedOverview.mode);
              return {
                id: site.id,
                slug: toAppSlug(site.name, site.id),
                name: site.name,
                deployTargetId: site.deployTargetId,
                clientId: ownership.clientId,
                clientDbId: ownership.clientDbId,
                clientName: ownership.clientName,
                status: site.status,
                ownershipState: ownership.ownershipState,
                ownershipDiagnostic: ownership.ownershipDiagnostic,
                source: "coolify" as const,
                coolifyServiceUuid: site.id,
                coolifyProjectId: site.coolifyProjectId,
                coolifyProjectName: site.coolifyProjectName,
                coolifyEnvironmentId: site.coolifyEnvironmentId,
                coolifyEnvironmentName: site.coolifyEnvironmentName,
                isStagingResource: false
              };
            });

      if (legacyRecords.length > 0 || coolifyRecords.length > 0) {
        const mergedFallbackRecords = [...legacyRecords, ...coolifyRecords];
        recordSiteDirectoryDiagnostics(mergedFallbackRecords, true, "legacy_or_coolify_fallback_after_site_query_error");
        return mergedFallbackRecords;
      }

      throw siteQueryError;
    }
  } catch (error) {
    if (isPrismaSchemaMismatchError(error)) {
      console.error(
        "[jongo] listSiteDirectory: Prisma schema mismatch detected. Migration required before DB-backed site mapping can run.",
        "Run: npx prisma migrate deploy --schema .\\prisma\\schema.prisma",
        "Error:", error
      );
    }

    if (scopeApplied) {
      recordSiteDirectoryDiagnostics([], true, "top_level_exception_scoped_empty");
      return [];
    }

    console.error(
      "[jongo] listSiteDirectory: DB query failed, falling back to Coolify-only data.",
      "DATABASE_URL present:", !!process.env.DATABASE_URL,
      "Error:", error
    );
    overview = overview ?? (await getCoolifyOverview());
    const resolvedOverview = overview;
    if (!resolvedOverview) {
      recordSiteDirectoryDiagnostics([], true, "top_level_exception_without_overview");
      return [];
    }

    const fallbackRecords = resolvedOverview.sites
      .filter((site) => !isLikelyStagingSite(site))
      .map((site) => {
        const ownership = resolveOwnershipForCoolifySite(site, resolvedOverview.mode);
        return {
          id: site.id,
          name: site.name,
          deployTargetId: site.deployTargetId,
          clientId: ownership.clientId,
          clientName: ownership.clientName,
          status: site.status,
          ownershipState: ownership.ownershipState,
          ownershipDiagnostic: ownership.ownershipDiagnostic,
          source: "coolify" as const,
          coolifyProjectId: site.coolifyProjectId,
          coolifyProjectName: site.coolifyProjectName,
          coolifyEnvironmentId: site.coolifyEnvironmentId,
          coolifyEnvironmentName: site.coolifyEnvironmentName,
          isStagingResource: false
        };
      });

    recordSiteDirectoryDiagnostics(fallbackRecords, true, "top_level_exception_coolify_only");
    return fallbackRecords;
  }
}

export async function getInventorySnapshot(viewer?: ViewerContext): Promise<InventorySnapshot> {
  const scopedUserId = getScopedViewerUserId(viewer);
  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(viewer);
  const scopeApplied = Boolean(scopedUserId && !bootstrapGlobalAccess);

  const overview = await getCoolifyOverview();
  const siteDirectory = await listSiteDirectory(viewer, overview);
  const dbMappedVisibleSites = siteDirectory.filter((site) => site.source === "db").length;
  const coolifyVisibleSites = siteDirectory.filter((site) => site.source === "coolify").length;

  let emptyReason: InventoryEmptyReason = "none";
  if (siteDirectory.length === 0) {
    if (overview.mode === "mock") {
      emptyReason = "mock_fallback_active";
    } else if (overview.fetchError) {
      emptyReason = "coolify_api_unavailable";
    } else if (scopeApplied) {
      emptyReason = "viewer_not_authorized";
    } else if (overview.sites.length === 0) {
      emptyReason = "no_resources_found";
    } else {
      emptyReason = "no_db_mappings_yet";
    }
  }

  recordRepositoryCall({
    operation: "listSiteDirectory",
    source:
      dbMappedVisibleSites > 0 && coolifyVisibleSites > 0
        ? "hybrid"
        : dbMappedVisibleSites > 0
          ? "db"
          : coolifyVisibleSites > 0
            ? "coolify"
            : "coolify",
    recordCount: siteDirectory.length,
    dbCount: dbMappedVisibleSites,
    coolifyCount: coolifyVisibleSites,
    mockCount: 0,
    scopeApplied,
    viewerUserIdPresent: Boolean(viewer?.userId),
    viewerUserIdIsUuid: Boolean(scopedUserId),
    bootstrapGlobalAccess,
    fallbackUsed: false,
    note: `inventory_snapshot:${emptyReason}`
  });

  return {
    overview,
    siteDirectory,
    scopeApplied,
    bootstrapGlobalAccess,
    emptyReason,
    counts: {
      visibleSites: siteDirectory.length,
      coolifySites: overview.sites.length,
      dbMappedVisibleSites,
      coolifyVisibleSites
    }
  };
}

export async function getSiteWorkspace(siteId: string, viewer?: ViewerContext): Promise<SiteWorkspaceRecord | undefined> {
  try {
    const prisma = await maybeGetDb();
    const overview = await getCoolifyOverview();
    const scopedUserId = getScopedViewerUserId(viewer);
    const scopeApplied = Boolean(scopedUserId && !hasBootstrapGlobalAccess(viewer));

    if (prisma) {
      let dbSite: any = null;
      try {
        const buildScopedWhere = (identity: string): any => {
          const identityFilter = buildSiteIdentityWhere(identity);
          const where: any = { ...identityFilter };
          if (scopeApplied && scopedUserId) {
            where.AND = [
              {
                OR: [
                  {
                    organization: {
                      deletedAt: null,
                      OR: [
                        { ownerId: scopedUserId },
                        { collaborators: { some: { userId: scopedUserId, deletedAt: null } } }
                      ]
                    }
                  },
                  { collaborators: { some: { userId: scopedUserId, deletedAt: null } } }
                ]
              }
            ];
          }

          return where;
        };

        const loadDbSite = async (where: any) => {
          try {
            return await prisma.site.findFirst({
              where,
              select: {
                id: true,
                organizationId: true,
                slug: true,
                name: true,
                description: true,
                coolifyServiceUuid: true,
                coolifyProjectId: true,
                stagingEnabled: true,
                isStagingResource: true,
                gitRepositoryUrl: true,
                organization: {
                  select: {
                    id: true,
                    slug: true,
                    name: true,
                    coolifyProjectId: true,
                    coolifyProjectName: true,
                    coolifyProjectLinks: {
                      select: { coolifyProjectId: true, coolifyProjectName: true, isPrimary: true },
                      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
                    }
                  }
                },
                environments: { include: { deployments: { orderBy: { triggeredAt: "desc" }, take: 3 } } }
              }
            });
          } catch (error) {
            if (!isPrismaUnknownFieldError(error, "coolifyProjectLinks")) {
              throw error;
            }

            return prisma.site.findFirst({
              where,
              select: {
                id: true,
                organizationId: true,
                slug: true,
                name: true,
                description: true,
                coolifyServiceUuid: true,
                coolifyProjectId: true,
                stagingEnabled: true,
                isStagingResource: true,
                gitRepositoryUrl: true,
                organization: {
                  select: {
                    id: true,
                    slug: true,
                    name: true,
                    coolifyProjectId: true,
                    coolifyProjectName: true
                  }
                },
                environments: { include: { deployments: { orderBy: { triggeredAt: "desc" }, take: 3 } } }
              }
            });
          }
        };

        dbSite = await loadDbSite(buildScopedWhere(siteId));

        if (!dbSite) {
          const coolifySiteMatch = overview.sites.find(
            (item) => item.id === siteId || item.deployTargetId === siteId || toAppSlug(item.name, item.id) === siteId
          );
          const resolvedIdentity = coolifySiteMatch?.id?.trim() || coolifySiteMatch?.deployTargetId?.trim();

          if (resolvedIdentity && resolvedIdentity !== siteId) {
            dbSite = await loadDbSite(buildScopedWhere(resolvedIdentity));
          }
        }
      } catch (error) {
        if (!isPrismaSchemaMismatchError(error)) {
          console.error("[jongo] getSiteWorkspace: DB site lookup failed before legacy fallback.", error);
        }
      }

      if (dbSite) {
        let temporaryDomainSlug: string | undefined;
        let temporaryDomainSuffix: string | undefined;
        if (await hasTemporaryDomainColumns(prisma)) {
          try {
            const temporaryDomainValues = await prisma.site.findUnique({
              where: { id: dbSite.id },
              select: {
                temporaryDomainSlug: true,
                temporaryDomainSuffix: true
              }
            });
            temporaryDomainSlug = temporaryDomainValues?.temporaryDomainSlug ?? undefined;
            temporaryDomainSuffix = temporaryDomainValues?.temporaryDomainSuffix ?? undefined;
          } catch (error) {
            if (!isPrismaSchemaMismatchError(error)) {
              throw error;
            }

            hasCheckedTemporaryDomainColumns = true;
            temporaryDomainColumnsAvailable = false;
          }
        }

        // Enrich with Coolify data if UUID is stored
        const coolifyMatch = dbSite.coolifyServiceUuid
          ? overview.sites.find(
              (cs) => cs.id === dbSite.coolifyServiceUuid || cs.deployTargetId === dbSite.coolifyServiceUuid
            )
          : undefined;
        const primaryOrgProject = [...(dbSite.organization.coolifyProjectLinks ?? [])].sort((a: any, b: any) => {
          if (Boolean(a.isPrimary) !== Boolean(b.isPrimary)) {
            return a.isPrimary ? -1 : 1;
          }

          return 0;
        })[0];

        const recentActivity = dbSite.environments.flatMap((env: any) =>
          env.deployments.map((dep: any) => `${env.name} ${dep.status}`)
        );

        return {
          id: dbSite.id,
          slug: dbSite.slug ?? toAppSlug(dbSite.name, dbSite.id),
          name: dbSite.name,
          description: dbSite.description ?? undefined,
          deployTargetId: coolifyMatch?.deployTargetId ?? dbSite.coolifyServiceUuid ?? "",
          clientId: dbSite.organization.slug,
          clientName: dbSite.organization.name,
          status: coolifyMatch?.status ?? "unknown",
          productionStatus: coolifyMatch?.productionStatus ?? "unknown",
          stagingStatus: coolifyMatch?.stagingStatus ?? "unknown",
          stagingEnabled: dbSite.stagingEnabled,
          isStagingResource: dbSite.isStagingResource ?? false,
          deploymentCount: dbSite.environments.reduce((n: number, env: any) => n + env.deployments.length, 0),
          recentActivity,
          siteType: coolifyMatch?.siteType ?? "generic",
            resourceType: coolifyMatch?.resourceType,
          coolifyServiceUuid: dbSite.coolifyServiceUuid ?? undefined,
          coolifyProjectId:
            dbSite.coolifyProjectId ??
            primaryOrgProject?.coolifyProjectId ??
            dbSite.organization.coolifyProjectId ??
            coolifyMatch?.coolifyProjectId,
          coolifyProjectName:
            primaryOrgProject?.coolifyProjectName ??
            dbSite.organization.coolifyProjectName ??
            coolifyMatch?.coolifyProjectName,
          coolifyEnvironmentId: coolifyMatch?.coolifyEnvironmentId,
          coolifyEnvironmentName: coolifyMatch?.coolifyEnvironmentName,
          gitRepositoryUrl: dbSite.gitRepositoryUrl ?? undefined,
          temporaryDomainSlug,
          temporaryDomainSuffix,
          organizationId: dbSite.organizationId,
          ownershipState: "mapped",
          ownershipDiagnostic: `Client: ${dbSite.organization.name}`,
          source: "db" as const
        };
      }

      if (scopeApplied) {
        return undefined;
      }

      if (await hasLegacySchema(prisma)) {
        const legacyProjects: Array<{
          id: string;
          clientId: string | null;
          orgId: string | null;
          name: string;
          description: string | null;
          status: string | null;
          clientName: string | null;
        }> = await prisma.$queryRaw`
          select
            p.id as "id",
            p.client_id as "clientId",
            p.org_id as "orgId",
            p.name as "name",
            p.description as "description",
            p.status::text as "status",
            c.name as "clientName"
          from projects p
          left join clients c on c.id = p.client_id
          where p.id::text = ${siteId}
          limit 1
        `;

        const legacyProject = legacyProjects[0];
        if (legacyProject) {
          const mappedStatus = mapLegacyProjectStatus(legacyProject.status);
          return {
            id: legacyProject.id,
            slug: toAppSlug(legacyProject.name, legacyProject.id),
            name: legacyProject.name,
            description: legacyProject.description ?? undefined,
            deployTargetId: legacyProject.id,
            clientId: legacyProject.clientId ?? legacyProject.orgId ?? "orphaned",
            clientName: legacyProject.clientName ?? "Client",
            status: mappedStatus,
            productionStatus: mappedStatus,
            stagingStatus: mappedStatus,
            stagingEnabled: mappedStatus !== "unknown",
            deploymentCount: 0,
            recentActivity: legacyProject.status ? [`Project ${legacyProject.status}`] : [],
            siteType: "generic",
              resourceType: undefined,
            coolifyServiceUuid: undefined,
            coolifyProjectId: undefined,
            coolifyProjectName: undefined,
            coolifyEnvironmentId: undefined,
            coolifyEnvironmentName: undefined,
            gitRepositoryUrl: undefined,
            organizationId: legacyProject.clientId ?? legacyProject.orgId ?? undefined,
            ownershipState: "mapped",
            ownershipDiagnostic: `Client: ${legacyProject.clientName ?? "Client"}`,
            source: "db" as const
          };
        }
      }
    }

    // Fallback: Coolify-only lookup (for sites not yet in DB)
    if (scopeApplied) {
      return undefined;
    }

    const site = overview.sites.find(
      (item) => item.id === siteId || item.deployTargetId === siteId || toAppSlug(item.name, item.id) === siteId
    );
    const ownership = site ? resolveOwnershipForCoolifySite(site, overview.mode) : undefined;

    if (!site) return undefined;

    const deploymentCount = overview.deployments.filter((dep) => dep.siteName === site.name).length;

    return {
      id: site.id,
      slug: toAppSlug(site.name, site.id),
      name: site.name,
      deployTargetId: site.deployTargetId,
      clientId: ownership?.clientId ?? "orphaned",
      clientName: ownership?.clientName ?? "Orphaned",
      status: site.status,
      productionStatus: site.productionStatus,
      stagingStatus: site.stagingStatus,
      stagingEnabled: site.stagingStatus !== "unknown",
      deploymentCount,
      siteType: site.siteType,
      resourceType: site.resourceType,
      recentActivity: overview.deployments
        .filter((dep) => dep.siteName === site.name)
        .slice(0, 3)
        .map((dep) => `${dep.environment} ${dep.status}`),
      coolifyServiceUuid: site.id,
      coolifyProjectId: site.coolifyProjectId,
      coolifyProjectName: site.coolifyProjectName,
      coolifyEnvironmentId: site.coolifyEnvironmentId,
      coolifyEnvironmentName: site.coolifyEnvironmentName,
      ownershipState: ownership?.ownershipState ?? "unavailable",
      ownershipDiagnostic: ownership?.ownershipDiagnostic ?? "Coolify project unavailable from API",
      source: "coolify" as const
    };
  } catch {
    if (shouldApplyViewerScope(viewer)) {
      return undefined;
    }

    // Last-resort Coolify fallback
    const overview = await getCoolifyOverview();
    const site = overview.sites.find(
      (item) => item.id === siteId || item.deployTargetId === siteId || toAppSlug(item.name, item.id) === siteId
    );
    const ownership = site ? resolveOwnershipForCoolifySite(site, overview.mode) : undefined;

    if (!site) return undefined;

    return {
      id: site.id,
      slug: toAppSlug(site.name, site.id),
      name: site.name,
      deployTargetId: site.deployTargetId,
      clientId: ownership?.clientId ?? "orphaned",
      clientName: ownership?.clientName ?? "Orphaned",
      status: site.status,
      productionStatus: site.productionStatus,
      stagingStatus: site.stagingStatus,
      stagingEnabled: site.stagingStatus !== "unknown",
      deploymentCount: overview.deployments.filter((dep) => dep.siteName === site.name).length,
      siteType: site.siteType,
      resourceType: site.resourceType,
      recentActivity: [],
      coolifyProjectId: site.coolifyProjectId,
      coolifyProjectName: site.coolifyProjectName,
      coolifyEnvironmentId: site.coolifyEnvironmentId,
      coolifyEnvironmentName: site.coolifyEnvironmentName,
      ownershipState: ownership?.ownershipState ?? "unavailable",
      ownershipDiagnostic: ownership?.ownershipDiagnostic ?? "Coolify project unavailable from API",
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

export async function listSiteDeployments(siteId: string, viewer?: ViewerContext): Promise<SiteDeploymentRecord[]> {
  try {
    const workspace = await getSiteWorkspace(siteId, viewer);
    if (!workspace) {
      return [];
    }

    const prisma = await maybeGetDb();

    if (prisma) {
      const dbSite = await prisma.site.findFirst({
        where: { ...buildSiteIdentityWhere(workspace.id), deletedAt: null },
        select: { id: true, coolifyServiceUuid: true, name: true }
      });

      const resolvedSiteId = dbSite?.id;
      const rows: any[] = resolvedSiteId ? await prisma.deployment.findMany({
        where: {
          environment: {
            siteId: resolvedSiteId,
            site: { deletedAt: null }
          }
        },
        include: {
          environment: { select: { name: true } },
          triggeredBy: { select: { email: true, fullName: true } }
        },
        orderBy: { triggeredAt: "desc" },
        take: 50
      }) : [];

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
    const workspace = await getSiteWorkspace(siteId, viewer);
    if (!workspace) {
      return [];
    }

    const lookupId = workspace.coolifyServiceUuid ?? workspace.id;
    const site = overview.sites.find(
      (item) =>
        item.id === lookupId ||
        item.deployTargetId === lookupId ||
        toAppSlug(item.name, item.id) === siteId ||
        toAppSlug(item.name, item.id) === lookupId
    );
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
