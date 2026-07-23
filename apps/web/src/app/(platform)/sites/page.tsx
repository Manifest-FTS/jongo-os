import Link from "next/link";
import { getCoolifyAppBackupInventory, getCoolifyAppStagingCapability } from "@/lib/coolify";
import { buildBackupReadModelSnapshot } from "@/lib/backup-read-model";
import { getCachedDirectoryBackupPosture, type DirectoryBackupPosture } from "@/lib/directory-backup-posture-cache";
import { getCachedDirectoryStagingPosture, type DirectoryStagingPosture } from "@/lib/directory-staging-posture-cache";
import { getAppsEmptyStateMessage } from "@/lib/reason-messages";
import { getInventorySnapshot, isClientAdmin } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { ArrowRightIcon } from "@/components/JongoIcons";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";
import SiteDirectoryView from "@/components/SiteDirectoryView";

export const dynamic = "force-dynamic";

const DIRECTORY_BACKUP_FETCH_BATCH_SIZE = 4;
const DIRECTORY_BACKUP_POSTURE_TTL_MS = 60_000;
const DIRECTORY_STAGING_POSTURE_TTL_MS = 60_000;

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function hasRecentSuccessfulBackup(iso: string, maxAgeDays = 7): boolean {
  const ageMs = Date.now() - new Date(iso).getTime();
  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function getLatestSuccessfulBackupTime(inventory: Awaited<ReturnType<typeof getCoolifyAppBackupInventory>>): string | null {
  if (inventory.source !== "live") {
    return null;
  }

  const successful = inventory.recentExecutions.find((entry) => entry.status === "success" && entry.finishedAt);
  return successful?.finishedAt ?? null;
}

async function buildDirectoryBackupPosture(
  siteDirectory: Awaited<ReturnType<typeof getInventorySnapshot>>["siteDirectory"],
  overviewMode: "live" | "mock"
): Promise<
  Map<
    string,
    DirectoryBackupPosture
  >
> {
  const backupPosture = new Map<string, DirectoryBackupPosture>();

  if (overviewMode !== "live") {
    return backupPosture;
  }

  const records: Array<{ siteId: string; posture: DirectoryBackupPosture } | null> = [];

  for (let index = 0; index < siteDirectory.length; index += DIRECTORY_BACKUP_FETCH_BATCH_SIZE) {
    const batch = siteDirectory.slice(index, index + DIRECTORY_BACKUP_FETCH_BATCH_SIZE);
    const batchRecords = await Promise.all(
      batch.map(async (site) => {
        const appUuid = site.coolifyServiceUuid ?? (site.source === "coolify" ? site.id : undefined);
        if (!appUuid) {
          return null;
        }

        const posture = await getCachedDirectoryBackupPosture(
          appUuid,
          DIRECTORY_BACKUP_POSTURE_TTL_MS,
          async (): Promise<DirectoryBackupPosture> => {
            const inventory = await getCoolifyAppBackupInventory(appUuid);
            const successfulBackupAt = getLatestSuccessfulBackupTime(inventory);
            const localStatus = inventory.source !== "live"
              ? "Status unknown"
              : inventory.configured
                ? (successfulBackupAt && hasRecentSuccessfulBackup(successfulBackupAt) ? "Protected (recent)" : "Protected (stale)")
                : "Not protected";
            const readModel = buildBackupReadModelSnapshot({
              ownership: `${site.clientName} / ${site.name}`,
              localStatus,
              schedules: inventory.schedules.filter((schedule) => schedule.enabled)
            });

            return {
              localStatus: readModel.localStatus,
              offsiteLabel: readModel.offsite.label,
              offsiteTone: readModel.offsite.tone,
              checkedAt: inventory.checkedAt
            };
          }
        );

        return {
          siteId: site.id,
          posture
        };

      })
    );

    records.push(...batchRecords);
  }

  for (const record of records) {
    if (!record) {
      continue;
    }

    backupPosture.set(record.siteId, {
      localStatus: record.posture.localStatus,
      offsiteLabel: record.posture.offsiteLabel,
      offsiteTone: record.posture.offsiteTone,
      checkedAt: record.posture.checkedAt
    });
  }

  return backupPosture;
}

async function buildDirectoryStagingPosture(
  siteDirectory: Awaited<ReturnType<typeof getInventorySnapshot>>["siteDirectory"],
  overviewMode: "live" | "mock"
): Promise<
  Map<
    string,
    DirectoryStagingPosture
  >
> {
  const stagingPosture = new Map<string, DirectoryStagingPosture>();

  if (overviewMode !== "live") {
    return stagingPosture;
  }

  const records: Array<{ siteId: string; posture: DirectoryStagingPosture } | null> = [];

  for (let index = 0; index < siteDirectory.length; index += DIRECTORY_BACKUP_FETCH_BATCH_SIZE) {
    const batch = siteDirectory.slice(index, index + DIRECTORY_BACKUP_FETCH_BATCH_SIZE);
    const batchRecords = await Promise.all(
      batch.map(async (site) => {
        const appUuid = site.coolifyServiceUuid ?? (site.source === "coolify" ? site.id : undefined);
        if (!appUuid) {
          return null;
        }

        const posture = await getCachedDirectoryStagingPosture(
          appUuid,
          DIRECTORY_STAGING_POSTURE_TTL_MS,
          async (): Promise<DirectoryStagingPosture> => {
            const capability = await getCoolifyAppStagingCapability(appUuid, site.coolifyProjectId ?? undefined);
            return {
              environmentReady: Boolean(capability.detected),
              targetAttached: Boolean(capability.applicationUuid),
              checkedAt: capability.checkedAt
            };
          }
        );

        return {
          siteId: site.id,
          posture
        };
      })
    );

    records.push(...batchRecords);
  }

  for (const record of records) {
    if (!record) {
      continue;
    }

    stagingPosture.set(record.siteId, {
      environmentReady: record.posture.environmentReady,
      targetAttached: record.posture.targetAttached,
      checkedAt: record.posture.checkedAt
    });
  }

  return stagingPosture;
}

export default async function SitesPage() {
  const session = await auth();
  const viewerUserId = session?.user?.id;
  const inventory = await getInventorySnapshot({
    userId: viewerUserId,
    email: session?.user?.email
  });
  const overview = inventory.overview;
  const siteDirectory = inventory.siteDirectory;
  const emptyReason = inventory.emptyReason;
  const [backupPostureBySiteId, stagingPostureBySiteId] = await Promise.all([
    buildDirectoryBackupPosture(siteDirectory, overview.mode),
    buildDirectoryStagingPosture(siteDirectory, overview.mode)
  ]);

  const uniqueClientDbIds = [...new Set(siteDirectory.map((site) => site.clientDbId).filter((id): id is string => Boolean(id)))];
  const adminStateEntries = viewerUserId
    ? await Promise.all(
        uniqueClientDbIds.map(async (clientDbId) => [clientDbId, await isClientAdmin(clientDbId, viewerUserId)] as const)
      )
    : [];
  const clientAdminState = new Map(adminStateEntries);
  const isCollaboratorView = siteDirectory.length > 0 && !siteDirectory.some((site) => {
    if (!site.clientDbId) return false;
    return Boolean(clientAdminState.get(site.clientDbId));
  });

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Apps ({siteDirectory.length})</h1>
          <p className="page-subtitle">Filter by name or health and switch between list and grid as needed.</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
            <span className={`status-chip ${overview.mode}`}>{overview.mode}</span>
            {overview.mode === "live"
              ? (
                <>
                  Live provider · {formatAgo(overview.generatedAt)}
                  {overview.fetchError && siteDirectory.length === 0 && <span style={{ color: "var(--error, #c0392b)" }}>· API unavailable</span>}
                </>
              )
              : "Provider not configured — demo mode"}
            {siteDirectory.length > 0 && (
              <span style={{ color: "var(--muted)" }}>
                · {siteDirectory.length} app{siteDirectory.length === 1 ? "" : "s"} visible ({inventory.counts.dbMappedVisibleSites} mapped, {inventory.counts.coolifyVisibleSites} live)
              </span>
            )}
          </p>
        </div>
      </div>

      {siteDirectory.length === 0 ? (
        <div className="card">
          {(() => {
            const emptyMsg = getAppsEmptyStateMessage(emptyReason);
            return (
              <>
                <p className="card-muted">{emptyMsg.heading}</p>
                <p className="form-help" style={{ marginBottom: "0.75rem" }}>
                  {emptyMsg.description}
                </p>
              </>
            );
          })()}

          {(emptyReason === "coolify_api_unavailable" || emptyReason === "mock_fallback_active") ? (
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem" }}>
              <Link href="/settings" className="action-link">Open platform settings to verify deployment configuration <ArrowRightIcon className="btn-icon" /></Link>
            </p>
          ) : null}

          {emptyReason === "no_db_mappings_yet" ? (
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem" }}>
              <Link href="/clients" className="action-link">Open clients to map app ownership <ArrowRightIcon className="btn-icon" /></Link>
            </p>
          ) : null}

          <div style={{ marginBottom: "0.75rem" }}>
            <CreateOrganizationForm />
          </div>
          <p style={{ marginTop: "0.5rem" }}>
            <Link href="/clients" className="action-link">Manage clients <ArrowRightIcon className="btn-icon" /></Link>
          </p>
        </div>
      ) : (
        <SiteDirectoryView
          userId={session?.user?.id}
          isCollaboratorView={isCollaboratorView}
          sites={siteDirectory.map((site) => {
            const overviewSite = overview.sites.find((item) => item.id === site.coolifyServiceUuid || item.id === site.id);
            const showInternalMetadata = site.clientDbId ? Boolean(clientAdminState.get(site.clientDbId)) : false;
            const isStagingResource =
              site.coolifyEnvironmentName?.toLowerCase().includes("staging")
              || site.name.toLowerCase().includes("staging")
              || site.slug?.toLowerCase().includes("staging")
              || false;

            return {
              id: site.id,
              name: site.name,
              description: site.description,
              clientId: site.clientId,
              clientName: site.clientName,
              status: overviewSite?.status ?? site.status,
              ownershipState: site.ownershipState,
              ownershipDiagnostic: site.ownershipDiagnostic,
              source: site.source,
              href: `/apps/${site.slug ?? site.id}`,
              clientHref: site.ownershipState === "mapped" ? `/clients/${site.clientId}` : undefined,
              resourceType: site.resourceType,
              showInternalMetadata,
              backupLocalStatus: backupPostureBySiteId.get(site.id)?.localStatus,
              backupOffsiteLabel: backupPostureBySiteId.get(site.id)?.offsiteLabel,
              backupOffsiteTone: backupPostureBySiteId.get(site.id)?.offsiteTone,
              backupCheckedAt: backupPostureBySiteId.get(site.id)?.checkedAt,
              stagingEnvironmentReady: stagingPostureBySiteId.get(site.id)?.environmentReady,
              stagingTargetAttached: stagingPostureBySiteId.get(site.id)?.targetAttached,
              stagingCheckedAt: stagingPostureBySiteId.get(site.id)?.checkedAt,
              isStagingResource
            };
          })}
        />
      )}
    </div>
  );
}
