import { db } from "@/lib/db";
import { getCoolifyOverview, type SiteOverview } from "@/lib/coolify";

type LinkedProjectRecord = {
  coolifyProjectId: string;
  coolifyProjectName: string | null;
};

export type CoolifyProjectImportResult = {
  linkedProjectCount: number;
  matchedCoolifySites: number;
  createdSites: number;
  skippedSites: number;
};

function normalized(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function makeUniqueSlug(baseSlug: string, existingSlugs: Set<string>): string {
  const truncatedBase = baseSlug.slice(0, 60);
  if (!existingSlugs.has(truncatedBase)) {
    existingSlugs.add(truncatedBase);
    return truncatedBase;
  }

  let suffix = 2;
  while (true) {
    const suffixText = `-${suffix}`;
    const candidate = `${truncatedBase.slice(0, Math.max(1, 60 - suffixText.length))}${suffixText}`;
    if (!existingSlugs.has(candidate)) {
      existingSlugs.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function createSiteSlug(site: SiteOverview, existingSlugs: Set<string>): string {
  const baseName = slugify(site.name) || "app";
  const idSuffix = site.id.slice(0, 8).toLowerCase();
  return makeUniqueSlug(`${baseName}-${idSuffix}`, existingSlugs);
}

async function loadLinkedProjects(organizationId: string): Promise<LinkedProjectRecord[]> {
  const organization = await db.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
    select: { id: true, coolifyProjectId: true, coolifyProjectName: true }
  });

  if (!organization) {
    return [];
  }

  const linkedProjects = new Map<string, LinkedProjectRecord>();

  const addProject = (coolifyProjectId?: string | null, coolifyProjectName?: string | null) => {
    const projectId = coolifyProjectId?.trim();
    if (!projectId || linkedProjects.has(projectId)) {
      return;
    }

    linkedProjects.set(projectId, {
      coolifyProjectId: projectId,
      coolifyProjectName: coolifyProjectName?.trim() ? coolifyProjectName.trim() : null
    });
  };

  addProject(organization.coolifyProjectId, organization.coolifyProjectName);

  const activeLinks = await db.$queryRaw<Array<{ coolifyProjectId: string; coolifyProjectName: string | null }>>`
    select
      l."coolifyProjectId",
      l."coolifyProjectName"
    from "OrganizationCoolifyProjectLink" l
    where l."organizationId" = ${organizationId}::uuid
      and l."deletedAt" is null
    order by l."isPrimary" desc, l."createdAt" asc
  `;

  for (const link of activeLinks) {
    addProject(link.coolifyProjectId, link.coolifyProjectName);
  }

  return [...linkedProjects.values()];
}

export async function importLinkedCoolifyProjectSites(organizationId: string): Promise<CoolifyProjectImportResult> {
  const linkedProjects = await loadLinkedProjects(organizationId);

  if (linkedProjects.length === 0) {
    return {
      linkedProjectCount: 0,
      matchedCoolifySites: 0,
      createdSites: 0,
      skippedSites: 0
    };
  }

  const overview = await getCoolifyOverview();
  if (overview.mode !== "live" || overview.sites.length === 0) {
    return {
      linkedProjectCount: linkedProjects.length,
      matchedCoolifySites: 0,
      createdSites: 0,
      skippedSites: 0
    };
  }

  const linkedProjectIds = new Set(linkedProjects.map((project) => project.coolifyProjectId));
  const coolifySites = overview.sites.filter((site) => site.coolifyProjectId && linkedProjectIds.has(site.coolifyProjectId));

  const existingSites: Array<{
    name: string;
    slug: string;
    coolifyServiceId: string | null;
    coolifyServiceUuid: string | null;
    coolifyProjectId: string | null;
  }> = await db.site.findMany({
    where: { organizationId, deletedAt: null },
    select: {
      name: true,
      slug: true,
      coolifyServiceId: true,
      coolifyServiceUuid: true,
      coolifyProjectId: true
    }
  });

  const existingNames = new Set<string>(existingSites.map((site) => normalized(site.name)).filter((value): value is string => Boolean(value)));
  const existingSlugs = new Set<string>(existingSites.map((site) => site.slug).filter((value): value is string => Boolean(value)));
  const existingCoolifyIdentifiers = new Set<string>();

  for (const site of existingSites) {
    if (site.coolifyServiceId) existingCoolifyIdentifiers.add(site.coolifyServiceId);
    if (site.coolifyServiceUuid) existingCoolifyIdentifiers.add(site.coolifyServiceUuid);
    if (site.coolifyProjectId) existingCoolifyIdentifiers.add(site.coolifyProjectId);
  }

  let createdSites = 0;
  let skippedSites = 0;

  for (const site of coolifySites) {
    const normalizedName = normalized(site.name);
    const projectId = site.coolifyProjectId;

    if (
      existingCoolifyIdentifiers.has(site.id) ||
      existingCoolifyIdentifiers.has(site.deployTargetId) ||
      (normalizedName && existingNames.has(normalizedName))
    ) {
      skippedSites += 1;
      continue;
    }

    const linkedProject = linkedProjects.find((project) => project.coolifyProjectId === projectId);
    const coolifyProjectName = site.coolifyProjectName ?? linkedProject?.coolifyProjectName ?? null;

    await db.site.create({
      data: {
        organizationId,
        slug: createSiteSlug(site, existingSlugs),
        name: site.name,
        description: null,
        coolifyServiceId: site.deployTargetId || site.id,
        coolifyServiceUuid: site.id,
        coolifyProjectId: projectId,
        coolifyProjectName,
        stagingEnabled: false,
        gitRepositoryUrl: null,
        environments: {
          create: [
            { name: "production", isProductionLike: true },
            { name: "staging", isProductionLike: false }
          ]
        }
      }
    });

    existingNames.add(normalizedName);
    if (site.id) existingCoolifyIdentifiers.add(site.id);
    if (site.deployTargetId) existingCoolifyIdentifiers.add(site.deployTargetId);
    if (projectId) existingCoolifyIdentifiers.add(projectId);
    createdSites += 1;
  }

  return {
    linkedProjectCount: linkedProjects.length,
    matchedCoolifySites: coolifySites.length,
    createdSites,
    skippedSites
  };
}