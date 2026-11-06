import type { CoolifyOverview, SiteOverview } from "@/lib/coolify";

export type CoolifyAppPickerOption = {
  id: string;
  name: string;
  projectId?: string;
  projectName?: string;
  status: SiteOverview["status"];
  resourceType?: string;
  /** https URL of the repository Coolify deploys this app from, when Coolify reports one. */
  gitRepositoryUrl?: string;
};

/** A browsable https URL for a repository as Coolify stores it ("owner/repo", ssh or https). Never keeps credentials. */
export function normalizeGitRepositoryUrl(raw?: string | null): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const ssh = /^git@([^:\s]+):(.+?)(?:\.git)?$/i.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\.git$/i, "").replace(/\/$/, "");
    } catch {
      return undefined;
    }
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value.replace(/\.git$/i, "")}`;
  return undefined;
}

export type CoolifyResourceReference = { id: string; projectId?: string; environmentId?: string };

/**
 * Accepts either a bare Coolify id or the address bar URL of a resource page
 * (.../project/<p>/environment/<e>/application|service|database/<id>[/advanced]) and returns the resource id.
 * Anything else comes back unchanged, so a typed id is never altered.
 */
export function parseCoolifyResourceReference(input: string): CoolifyResourceReference {
  const text = input.trim();
  if (!/[/:]/.test(text)) return { id: text };
  let segments: string[];
  try {
    segments = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).pathname.split("/").filter(Boolean);
  } catch {
    return { id: text };
  }
  const after = (word: string) => {
    const at = segments.indexOf(word);
    return at >= 0 ? segments[at + 1] : undefined;
  };
  const id = after("application") ?? after("service") ?? after("database");
  if (!id) return { id: text };
  return { id, projectId: after("project"), environmentId: after("environment") };
}

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
      resourceType: site.resourceType,
      ...(normalizeGitRepositoryUrl(site.gitRepository) ? { gitRepositoryUrl: normalizeGitRepositoryUrl(site.gitRepository) } : {})
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}