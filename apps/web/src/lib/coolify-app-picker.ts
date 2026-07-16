import type { CoolifyOverview, SiteOverview } from "@/lib/coolify";

export type CoolifyAppPickerOption = {
  id: string;
  name: string;
  projectId?: string;
  projectName?: string;
  status: SiteOverview["status"];
  resourceType?: string;
};

type ExistingSiteReference = {
  coolifyServiceUuid?: string | null;
  deployTargetId?: string | null;
  name?: string;
};

function normalized(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

export function buildAvailableCoolifyAppOptions(
  overview: CoolifyOverview,
  linkedProjectIds: Iterable<string>,
  existingSites: ExistingSiteReference[]
): CoolifyAppPickerOption[] {
  const linkedProjectIdSet = new Set([...linkedProjectIds].map((value) => value.trim()).filter(Boolean));
  const existingIdentifiers = new Set<string>();
  const existingNames = new Set<string>();

  for (const site of existingSites) {
    if (site.coolifyServiceUuid) existingIdentifiers.add(site.coolifyServiceUuid);
    if (site.deployTargetId) existingIdentifiers.add(site.deployTargetId);
    if (site.name) existingNames.add(normalized(site.name));
  }

  return overview.sites
    .filter((site) => site.coolifyProjectId && linkedProjectIdSet.has(site.coolifyProjectId))
    .filter((site) => !existingIdentifiers.has(site.id) && !existingIdentifiers.has(site.deployTargetId))
    .filter((site) => !existingNames.has(normalized(site.name)))
    .map((site) => ({
      id: site.id,
      name: site.name,
      projectId: site.coolifyProjectId,
      projectName: site.coolifyProjectName,
      status: site.status,
      resourceType: site.resourceType
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}