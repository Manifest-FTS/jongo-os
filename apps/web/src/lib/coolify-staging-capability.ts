/** Which Coolify resource is an app's staging copy (split out of lib/coolify.ts; import from "@/lib/coolify"). */
import { pickStagingTarget } from "./staging-target-match";
import { readStagingTargetPins } from "./staging-target-pin";
import { coolifyFetch, ensureArray, extractStagingDomainList, resolveCoolifyProjectEndpointId, statusFromRaw, stringValue } from "./coolify-core";

export type StagingCapabilityRecord = {
  detected: boolean;
  resourceKind?: "application" | "service" | "database" | "unknown";
  projectEnvNames?: string[];
  environmentId?: string;
  environmentName?: string;
  applicationUuid?: string;
  applicationName?: string;
  stagingUrl?: string;
  fqdn?: string;
  status?: "healthy" | "degraded" | "error" | "unknown";
  stagingCandidateCount?: number;
  stagingMatchedCandidateCount?: number;
  /** The target is the copy Jongo recorded for this app, not a name match. */
  pinned?: boolean;
  note?: string;
  /** ISO timestamp of when this probe ran. */
  checkedAt: string;
};

// ─── Dry-Run Sync Plan Types ──────────────────────────────────────────────────

export type StagingSyncPlan = {
  source: { uuid: string; name: string; environment: string; fqdn?: string };
  target: { uuid: string; name: string; environment: string; fqdn?: string } | null;
  databaseBehavior: "snapshot-then-overwrite" | "skip" | "unknown";
  filesBehavior: "rsync-overwrite" | "skip" | "unknown";
  domainBehavior: "staging-domain-unchanged" | "temporary-domain" | "unknown";
  risks: string[];
  warnings: string[];
  note?: string;
};

// ─── Backup Inventory Fetching ────────────────────────────────────────────────

/**
 * Detect staging capability for a given Coolify application.
 * Looks for a staging environment in the same project and for a staging application.
 * Read-only – never creates or modifies resources.
 */
export async function getCoolifyAppStagingCapability(
  appUuid: string,
  projectId?: string,
  options?: { relaxedTargetMatch?: boolean; pinnedTargetUuid?: string | null }
): Promise<StagingCapabilityRecord> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const checkedAt = new Date().toISOString();
  const relaxedTargetMatch = Boolean(options?.relaxedTargetMatch);

  if (!baseUrl || !token) {
    return { detected: false, note: "missing_credentials", checkedAt };
  }

  // The copy Jongo recorded for this app wins over every name rule, strict and
  // relaxed alike: it is identity, not a guess. Copies recorded for OTHER apps
  // are never candidates, so a sibling in the same project cannot adopt one
  // through the lone-candidate rule. Looked up here rather than threaded
  // through the twenty-odd callers, so they cannot disagree.
  const recordedTargets = await readStagingTargetPins(appUuid);
  const pinnedTargetUuid = options?.pinnedTargetUuid !== undefined
    ? options.pinnedTargetUuid
    : recordedTargets.own;
  const otherAppsTargets = recordedTargets.others.filter((uuid) => uuid !== pinnedTargetUuid);

  try {
    const extractResourceName = (value: Record<string, unknown> | null | undefined): string =>
      value ? stringValue(value, ["name", "application_name", "service_name"], "") : "";

    // The matching rule lives in lib/staging-target-match.ts, where it is tested.
    // It used to be a closure here, which meant the single decision that attaches
    // an app to a staging resource — and then syncs production content into it —
    // had no test at all.
    const pickBestStagingTarget = (candidates: Record<string, unknown>[]): {
      selected?: Record<string, unknown>;
      candidateCount: number;
      matchedCount: number;
      adoptedWithoutNameMatch: boolean;
    } => {
      const byUuid = new Map<string, Record<string, unknown>>();
      const flat = candidates.map((candidate) => {
        const uuid = stringValue(candidate, ["uuid", "id"], "");
        if (uuid) byUuid.set(uuid, candidate);
        return { uuid, name: extractResourceName(candidate) };
      });

      const picked = pickStagingTarget(extractResourceName(rootResource), flat, {
        relaxed: relaxedTargetMatch,
        // Adopting "the only resource in the staging environment" regardless of
        // its name is fine for display and fatal for enabling, so it rides with
        // the relaxed flag rather than being unconditional.
        allowLoneCandidateFallback: relaxedTargetMatch,
        excludeUuid: appUuid,
        excludeUuids: otherAppsTargets,
        pinnedUuid: pinnedTargetUuid
      });

      return {
        selected: picked.selected ? byUuid.get(picked.selected.uuid) : undefined,
        candidateCount: picked.candidateCount,
        matchedCount: picked.matchedCount,
        adoptedWithoutNameMatch: picked.adoptedWithoutNameMatch
      };
    };

    let resourceKind: StagingCapabilityRecord["resourceKind"] = "unknown";
    let rootResource: Record<string, unknown> | null = null;

    const resourceLookups: Array<{
      kind: NonNullable<StagingCapabilityRecord["resourceKind"]>;
      path: string;
    }> = [
      { kind: "application", path: `/api/v1/applications/${appUuid}` },
      { kind: "service", path: `/api/v1/services/${appUuid}` },
      { kind: "database", path: `/api/v1/databases/${appUuid}` }
    ];

    for (const lookup of resourceLookups) {
      try {
        const payload = await coolifyFetch(lookup.path);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          rootResource = payload as Record<string, unknown>;
          resourceKind = lookup.kind;
          break;
        }
      } catch {
        // Try the next resource class.
      }
    }

    // Resolve project if not supplied
    let resolvedProjectId = projectId;
    if (!resolvedProjectId) {
      if (rootResource) {
        resolvedProjectId = stringValue(rootResource, ["project_uuid", "project_id", "project"], "");
      }
      if (!resolvedProjectId) {
        return {
          detected: false,
          resourceKind,
          note: rootResource ? "no_project_resolved" : "resource_not_found",
          checkedAt
        };
      }
    }

    if (!resolvedProjectId) {
      return { detected: false, resourceKind, note: "no_project_resolved", checkedAt };
    }

    // Get all environments for the project
    const projectEndpointId = await resolveCoolifyProjectEndpointId(resolvedProjectId);
    const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
    const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
      ? (projectPayload as Record<string, unknown>)
      : {};
    const environments = ensureArray(projectObj.environments ?? []);
    const projectEnvNames = environments
      .map((env) => stringValue(env as Record<string, unknown>, ["name", "environment_name"], ""))
      .filter((name) => name.length > 0);

    const stagingEnv = environments.find((env) => {
      const name = stringValue(env as Record<string, unknown>, ["name"], "").toLowerCase();
      return name.includes("stag") || name.includes("preview") || name === "dev";
    });

    if (!stagingEnv) {
      const note = projectEnvNames.length > 0 && projectEnvNames.every((name) => name.toLowerCase().includes("prod"))
        ? "project_only_has_production_environment"
        : "no_staging_environment_in_project";
      return { detected: false, resourceKind, projectEnvNames, note, checkedAt };
    }

    const stagingEnvObj = stagingEnv as Record<string, unknown>;
    const stagingEnvId = stringValue(stagingEnvObj, ["id", "uuid"], "");
    const stagingEnvName = stringValue(stagingEnvObj, ["name"], "staging");
    const projectIdCandidates = new Set<string>([resolvedProjectId, projectEndpointId].filter(Boolean));

    // Look for an application in the staging environment
    const stagingApplications = ensureArray(stagingEnvObj.applications ?? []);
    let stagingApp: Record<string, unknown> | undefined;
    let stagingService: Record<string, unknown> | undefined;
    let stagingCandidateCount = 0;
    let stagingMatchedCandidateCount = 0;

    const initialAppPick = pickBestStagingTarget(stagingApplications);
    stagingApp = initialAppPick.selected;
    stagingCandidateCount = initialAppPick.candidateCount;
    stagingMatchedCandidateCount = initialAppPick.matchedCount;

    // Some Coolify project payloads omit nested applications for environments.
    // Fall back to scanning the application inventory by environment ID/name.
    if (!stagingApp) {
      try {
        const applicationsPayload = await coolifyFetch("/api/v1/applications");
        const applications = ensureArray(applicationsPayload);
        const normalizedStagingEnvName = stagingEnvName.trim().toLowerCase();

        const candidateApplications = applications.filter((app) => {
          const appEnvId = stringValue(app, ["environment_id", "environmentId", "environment_uuid"], "");
          const appEnvName = stringValue(app, ["environment_name", "environment"], "").trim().toLowerCase();
          const appProjectId = stringValue(app, ["project_uuid", "project_id", "project"], "");
          const appDeletedAt = stringValue(app, ["deleted_at"], "");

          const matchesEnvironment =
            (stagingEnvId.length > 0 && appEnvId === stagingEnvId) ||
            (normalizedStagingEnvName.length > 0 && appEnvName === normalizedStagingEnvName);

          if (!matchesEnvironment) {
            return false;
          }

          if (appDeletedAt.length > 0) {
            return false;
          }

          if (projectIdCandidates.size === 0 || appProjectId.length === 0) {
            return true;
          }

          return projectIdCandidates.has(appProjectId);
        });

        const picked = pickBestStagingTarget(candidateApplications);
        stagingApp = picked.selected;
        stagingCandidateCount = Math.max(stagingCandidateCount, picked.candidateCount);
        stagingMatchedCandidateCount = Math.max(stagingMatchedCandidateCount, picked.matchedCount);
      } catch {
        // Keep reporting environment-only staging if list endpoint cannot be fetched.
      }
    }

    // Service resources can expose staging targets as services without a nested applications entry.
    if (!stagingApp && resourceKind === "service") {
      const stagingServices = ensureArray(stagingEnvObj.services ?? []);
      const initialServicePick = pickBestStagingTarget(stagingServices);
      stagingService = initialServicePick.selected;
      stagingCandidateCount = Math.max(stagingCandidateCount, initialServicePick.candidateCount);
      stagingMatchedCandidateCount = Math.max(stagingMatchedCandidateCount, initialServicePick.matchedCount);

      if (!stagingService) {
        try {
          const servicesPayload = await coolifyFetch("/api/v1/services");
          const services = ensureArray(servicesPayload);
          const normalizedStagingEnvName = stagingEnvName.trim().toLowerCase();

          const candidateServices = services.filter((service) => {
            const serviceEnvId = stringValue(service, ["environment_id", "environmentId", "environment_uuid"], "");
            const serviceEnvName = stringValue(service, ["environment_name", "environment"], "").trim().toLowerCase();
            const serviceProjectId = stringValue(service, ["project_uuid", "project_id", "project"], "");
            const serviceDeletedAt = stringValue(service, ["deleted_at"], "");

            const matchesEnvironment =
              (stagingEnvId.length > 0 && serviceEnvId === stagingEnvId) ||
              (normalizedStagingEnvName.length > 0 && serviceEnvName === normalizedStagingEnvName);

            if (!matchesEnvironment) {
              return false;
            }

            if (serviceDeletedAt.length > 0) {
              return false;
            }

            if (projectIdCandidates.size === 0 || serviceProjectId.length === 0) {
              return true;
            }

            return projectIdCandidates.has(serviceProjectId);
          });

          const picked = pickBestStagingTarget(candidateServices);
          stagingService = picked.selected;
          stagingCandidateCount = Math.max(stagingCandidateCount, picked.candidateCount);
          stagingMatchedCandidateCount = Math.max(stagingMatchedCandidateCount, picked.matchedCount);
        } catch {
          // Keep reporting environment-only staging if list endpoint cannot be fetched.
        }
      }
    }

    const resolvedStagingTarget = stagingApp ?? stagingService;

    if (!resolvedStagingTarget) {
      const note = stagingCandidateCount > 0 && stagingMatchedCandidateCount === 0
        ? "staging_environment_exists_for_other_resource"
        : "staging_environment_exists_no_application";
      return {
        detected: true,
        resourceKind,
        projectEnvNames,
        environmentId: stagingEnvId,
        environmentName: stagingEnvName,
        stagingCandidateCount,
        stagingMatchedCandidateCount,
        note,
        checkedAt
      };
    }

    const stagingAppUuid = stringValue(resolvedStagingTarget, ["uuid", "id"], "");
    const defaultTargetName = resourceKind === "service" ? "staging service" : "staging app";
    const stagingAppName = stringValue(resolvedStagingTarget, ["name"], defaultTargetName);
    let detailedStagingTarget = resolvedStagingTarget;
    const detailPath = resourceKind === "service"
      ? `/api/v1/services/${encodeURIComponent(stagingAppUuid)}`
      : `/api/v1/applications/${encodeURIComponent(stagingAppUuid)}`;

    if (stagingAppUuid) {
      try {
        const detailPayload = await coolifyFetch(detailPath);
        if (detailPayload && typeof detailPayload === "object" && !Array.isArray(detailPayload)) {
          detailedStagingTarget = detailPayload as Record<string, unknown>;
        }
      } catch {
        // Keep list payload fallback when detail endpoint is unavailable.
      }
    }

    const stagingDomains = extractStagingDomainList(detailedStagingTarget);
    const fqdn = stagingDomains.join(",") || undefined;
    const stagingUrl = stagingDomains[0] || undefined;
    const status = statusFromRaw(
      detailedStagingTarget.status ??
      detailedStagingTarget.current_status ??
      detailedStagingTarget.server_status
    );

    return {
      detected: true,
      resourceKind,
      projectEnvNames,
      environmentId: stagingEnvId,
      environmentName: stagingEnvName,
      applicationUuid: stagingAppUuid || undefined,
      applicationName: stagingAppName || undefined,
      stagingUrl,
      fqdn,
      status,
      stagingCandidateCount,
      stagingMatchedCandidateCount,
      pinned: Boolean(pinnedTargetUuid && stagingAppUuid === pinnedTargetUuid),
      note: "full_staging_detected",
      checkedAt
    };
  } catch {
    return { detected: false, note: "fetch_error", checkedAt };
  }
}

// ─── Staging Sync Dry-Run Plan ────────────────────────────────────────────────

/**
 * Build a read-only dry-run plan for a production→staging sync.
 * This describes what WOULD happen – never executes anything.
 */
export async function buildStagingSyncDryRunPlan(
  productionAppUuid: string,
  productionAppName: string,
  stagingCapability: StagingCapabilityRecord
): Promise<StagingSyncPlan> {
  const source = {
    uuid: productionAppUuid,
    name: productionAppName,
    environment: "production"
  };

  if (!stagingCapability.detected || !stagingCapability.applicationUuid) {
    const hasEnvironmentOnlyStaging = Boolean(stagingCapability.detected && !stagingCapability.applicationUuid);
    return {
      source,
      target: null,
      databaseBehavior: "unknown",
      filesBehavior: "unknown",
      domainBehavior: "unknown",
      risks: [
        hasEnvironmentOnlyStaging
          ? "Staging environment exists but no staging application target is attached yet."
          : "No staging environment detected – cannot plan sync."
      ],
      warnings: [
        hasEnvironmentOnlyStaging
          ? "Turn staging on again (Try again) so a staging app is attached before sync or promote."
          : "Enable staging first in Settings."
      ]
    };
  }

  const target = {
    uuid: stagingCapability.applicationUuid,
    name: stagingCapability.applicationName ?? "Staging App",
    environment: stagingCapability.environmentName ?? "staging",
    fqdn: stagingCapability.fqdn
  };

  return {
    source,
    target,
    databaseBehavior: "snapshot-then-overwrite",
    filesBehavior: "rsync-overwrite",
    domainBehavior: "staging-domain-unchanged",
    risks: [
      "Staging database will be overwritten with a snapshot of production data.",
      "Any staging-only content will be lost."
    ],
    warnings: [
      "Review staging domain configuration before executing.",
      "Ensure production is stable before syncing to avoid copying bad state."
    ],
    note: "dry_run_only"
  };
}
