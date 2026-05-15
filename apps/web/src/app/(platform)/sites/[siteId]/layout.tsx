import { ReactNode } from "react";
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

  const tabs: WorkspaceTab[] = [
    { name: "Overview", href: `/sites/${siteId}`, match: "exact" },
    { name: "Deployments", href: `/sites/${siteId}/deployments` },
    { name: "Staging", href: `/sites/${siteId}/staging` },
    { name: "Settings", href: `/sites/${siteId}/settings` }
  ];

  return (
    <div>
      <div className="card page-hero" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ margin: "0 0 0.35rem" }}>
          Dashboard / Clients / {site?.clientName ?? "Unknown Client"} / {site?.name ?? siteId}
        </p>
        <h1 style={{ margin: 0 }}>{site?.name ?? siteId}</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Site operations workspace
        </p>

        <div className="hero-meta-row">
          <span className={`status-chip ${site?.status ?? "unknown"}`}>Overall {site?.status ?? "unknown"}</span>
          <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>
            Prod {site?.productionStatus ?? "unknown"}
          </span>
          <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>
            Staging {site?.stagingStatus ?? "unknown"}
          </span>
          <span className="tag">Health summary</span>
        </div>

        <details style={{ marginTop: "0.75rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
            Developer Details
          </summary>
          <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
            Data source: {site?.source ?? "unknown"}
          </p>
        </details>
      </div>

      <div className="card" style={{ marginBottom: "1rem", paddingTop: "0.75rem", paddingBottom: "0.75rem" }}>
        <WorkspaceTabs tabs={tabs} />
      </div>

      <div>{children}</div>
    </div>
  );
}
