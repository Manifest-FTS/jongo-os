import { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import WorkspaceTabs, { type WorkspaceTab } from "@/components/navigation/WorkspaceTabs";

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

  const tabs: WorkspaceTab[] = [
    { name: "Overview", href: `/apps/${siteId}`, match: "exact" },
    { name: "Deployments", href: `/apps/${siteId}/deployments` },
    { name: "Integrations", href: `/apps/${siteId}/integrations` },
    ...(site?.siteType === "wordpress" ? [{ name: "Plugins", href: `/apps/${siteId}/plugins` } as WorkspaceTab] : []),
    ...(site?.stagingEnabled ? [{ name: "Staging", href: `/apps/${siteId}/staging` } as WorkspaceTab] : []),
    { name: "Backups", href: `/apps/${siteId}/backups` },
    { name: "Analytics", href: `/apps/${siteId}/analytics` },
    { name: "Team", href: `/apps/${siteId}/team` },
    { name: "Settings", href: `/apps/${siteId}/settings` }
  ];

  const showOwnershipState = canViewInternalMetadata && site?.ownershipState !== "unavailable";
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
            <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>
              Prod
            </span>
            {site?.stagingEnabled ? (
              <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>
                Staging
              </span>
            ) : (
              <span className="tag">No staging</span>
            )}
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
