import { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { getCoolifyAppStagingCapability } from "@/lib/coolify";
import WorkspaceTabs, { type WorkspaceTab } from "@/components/navigation/WorkspaceTabs";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";

type Params = { params: Promise<{ siteId: string }> };

export default async function SiteWorkspaceLayout({
  children,
  params
}: {
  children: ReactNode;
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const session = await auth();
  const site = await getSiteWorkspace(siteId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!site) {
    notFound();
  }

  const canViewInternalMetadata = Boolean(
    session?.user?.id &&
    site.organizationId &&
    await isClientAdmin(site.organizationId, session.user.id)
  );

  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace: site,
    viewer: {
      userId: session?.user?.id,
      email: session?.user?.email
    }
  });

  const isWordPress = site.siteType === "wordpress" || site.resourceType === "WordPress";
  const isAdminViewer = permissionSnapshot.role === "admin";

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const stagingCapability = (site.stagingEnabled && appUuid)
    ? await getCoolifyAppStagingCapability(appUuid, site.coolifyProjectId ?? undefined, /* Relaxed: must match the API route, or the UI hides staging the platform did provision. */ { relaxedTargetMatch: true })
    : null;

  const stagingEnvironmentReady = Boolean(stagingCapability?.detected);
  const stagingTargetReady = Boolean(stagingCapability?.applicationUuid);
  const showStagingTab = Boolean(site.stagingEnabled || stagingEnvironmentReady || stagingTargetReady);
  const environmentName = (site.coolifyEnvironmentName ?? "").trim().toLowerCase();
  const isStagingWorkspace = environmentName.includes("stag") || environmentName.includes("preview") || environmentName === "dev";
  const primaryEnvironmentStatus = isStagingWorkspace ? site.stagingStatus : site.productionStatus;
  const primaryEnvironmentLabel = isStagingWorkspace ? "Staging" : "Prod";
  const showStagingReadyTag = !isStagingWorkspace && showStagingTab;

  // Whether to offer backup features at all. Read from the cached columns the
  // hourly reconciler maintains, so this costs no Coolify call per page load.
  //
  // Hidden only when we positively KNOW there is nothing to back up. A null
  // (never evaluated) or an app whose data lives in an external database keeps
  // the tab: the first must not make features vanish on an unknown, and the
  // second needs somewhere to be told its data is NOT backed up here.
  const backupCapability = await (async () => {
    try {
      const { getDb } = await import("@/lib/db");
      const prisma = await getDb();
      if (!prisma) return null;
      return await (prisma as any).site.findUnique({
        where: { id: site.id },
        select: { backupEligible: true, backupCapabilityReason: true, isStagingResource: true }
      });
    } catch {
      return null;
    }
  })();
  const showBackupsTab = !(
    backupCapability?.isStagingResource === true ||
    (backupCapability?.backupEligible === false && backupCapability?.backupCapabilityReason === "stateless")
  );

  const tabs: WorkspaceTab[] = [
    { name: "Overview", href: `/apps/${siteId}`, match: "exact" },
    ...(!isWordPress ? [{ name: "Deployments", href: `/apps/${siteId}/deployments` } as WorkspaceTab] : []),
    ...(!isWordPress && isAdminViewer ? [{ name: "Integrations", href: `/apps/${siteId}/integrations` } as WorkspaceTab] : []),
    ...(isWordPress ? [{ name: "Plugins", href: `/apps/${siteId}/plugins` } as WorkspaceTab] : []),
    ...(showStagingTab ? [{ name: "Staging", href: `/apps/${siteId}/staging` } as WorkspaceTab] : []),
    ...(showBackupsTab ? [{ name: "Backups", href: `/apps/${siteId}/backups` } as WorkspaceTab] : []),
    ...(isAdminViewer ? [{ name: "Analytics", href: `/apps/${siteId}/analytics` } as WorkspaceTab] : []),
    { name: "Advanced", href: `/apps/${siteId}/settings` }
  ];

  const showOwnershipState = permissionSnapshot.canViewInternalMetadata && site?.ownershipState !== "unavailable";
  const isMapped = site?.ownershipState === "mapped";

  return (
    <div className="workspace-shell">
      <div className="workspace-hero card">
        <div className="workspace-breadcrumb">
          <Link href="/apps" className="breadcrumb-link">Apps</Link>
          <span className="breadcrumb-sep">/</span>
          {isMapped && site.clientId ? (
            <>
              <Link href={`/clients/${site.clientId}`} className="breadcrumb-link">{site.clientName}</Link>
              <span className="breadcrumb-sep">/</span>
            </>
          ) : null}
          <span className="breadcrumb-current">{site?.name ?? siteId}</span>
        </div>

        <div className="workspace-hero-body">
          <div className="workspace-hero-title-group">
            <h1 className="workspace-title">{site?.name ?? siteId}</h1>
            {site?.description ? (
              <p className="workspace-subtitle">{site.description}</p>
            ) : null}
          </div>

          <div className="workspace-hero-chips">
            <span className={`status-chip ${site?.status ?? "unknown"}`}>
              {site?.status ?? "unknown"}
            </span>
            <span className={`status-chip ${primaryEnvironmentStatus ?? "unknown"}`}>
              {primaryEnvironmentLabel}
            </span>
            {showStagingReadyTag ? <span className="tag">Staging ready</span> : null}
            {showOwnershipState ? (
              <span className={`tag ${isMapped ? "tag-mapped" : "tag-warning"}`}>
                {isMapped ? "mapped" : "mapping needs review"}
              </span>
            ) : null}
          </div>
        </div>

      </div>

      <div className="workspace-tab-bar card">
        <WorkspaceTabs tabs={tabs} />
      </div>

      <div className="workspace-content">{children}</div>
    </div>
  );
}
