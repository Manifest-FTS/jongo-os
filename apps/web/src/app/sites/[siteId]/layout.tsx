import { ReactNode } from "react";
import { getClientForSite } from "../../../lib/clients";
import { getCoolifyOverview } from "../../../lib/coolify";

type Params = { params: Promise<{ siteId: string }> };

export default async function SiteWorkspaceLayout({
  children,
  params
}: {
  children: ReactNode;
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const client = getClientForSite(siteId);
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);

  const tabs = [
    { name: "Overview", href: `/sites/${siteId}` },
    { name: "Deployments", href: `/sites/${siteId}/deployments` },
    { name: "Staging", href: `/sites/${siteId}/staging` },
    { name: "Settings", href: `/sites/${siteId}/settings` }
  ];

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ margin: "0 0 0.35rem" }}>
          Dashboard / Clients / {client?.name ?? "Unknown Client"} / {site?.name ?? siteId}
        </p>
        <h1 style={{ margin: 0 }}>Site: {site?.name ?? siteId}</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Operational workspace
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginTop: "0.75rem" }}>
          <span className={`status-chip ${site?.status ?? "unknown"}`}>Overall {site?.status ?? "unknown"}</span>
          <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>
            Prod {site?.productionStatus ?? "unknown"}
          </span>
          <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>
            Staging {site?.stagingStatus ?? "unknown"}
          </span>
          <span className="tag">Source {overview.mode}</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1rem", paddingTop: "0.75rem", paddingBottom: "0.75rem" }}>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          {tabs.map((tab) => (
            <a key={tab.href} href={tab.href} style={{ textDecoration: "none", color: "inherit", fontWeight: 600 }}>
              {tab.name}
            </a>
          ))}
        </div>
      </div>

      <div>{children}</div>
    </div>
  );
}
