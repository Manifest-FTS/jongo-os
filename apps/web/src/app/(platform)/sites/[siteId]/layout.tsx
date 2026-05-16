import { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSiteWorkspace } from "@/lib/repositories";
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
  const site = await getSiteWorkspace(siteId);

  if (!site) {
    notFound();
  }

  const tabs: WorkspaceTab[] = [
    { name: "Overview", href: `/sites/${siteId}`, match: "exact" },
    { name: "Deployments", href: `/sites/${siteId}/deployments` },
    { name: "Integrations", href: `/sites/${siteId}/integrations` },
    { name: "Staging", href: `/sites/${siteId}/staging` },
    { name: "Backups", href: `/sites/${siteId}/backups` },
    { name: "Analytics", href: `/sites/${siteId}/analytics` },
    { name: "Team", href: `/sites/${siteId}/team` },
    { name: "Settings", href: `/sites/${siteId}/settings` },
    { name: "Advanced", href: `/sites/${siteId}/advanced` }
  ];

  const ownershipDiagnostic = site?.ownershipDiagnostic;
  const isMapped = site?.ownershipState === "mapped";

  return (
    <div className="workspace-shell">
      <div className="workspace-hero card">
        <div className="workspace-breadcrumb">
          <Link href="/sites" className="breadcrumb-link">Apps</Link>
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
            {ownershipDiagnostic ? (
              <span className={`tag ${isMapped ? "tag-mapped" : "tag-warning"}`}>
                {ownershipDiagnostic}
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
