import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteActivityFeed, getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

export default async function IntegrationsPage({ params }: Params) {
  const { siteId } = await params;
  const [workspace, overview, deployments, activity] = await Promise.all([
    getSiteWorkspace(siteId),
    getCoolifyOverview(),
    listSiteDeployments(siteId),
    getSiteActivityFeed(siteId, 4)
  ]);

  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const coolifySite = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const isWordPress = workspace?.siteType === "wordpress";
  const deploymentSource = deployments[0]?.source ?? overview.mode;

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Integrations</h2>
        <p className="card-muted">Provider plugins, WordPress signals, and integration status.</p>
      </article>

      <article className="card">
        <h3 className="card-title">Provider Connectivity</h3>
        <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.55rem" }}>
          <p style={{ margin: 0 }}>
            Deployment source: <span className="tag">{deploymentSource}</span>
          </p>
          <p style={{ margin: 0 }}>
            Coolify service: <span className="tag">{workspace?.coolifyServiceUuid ?? coolifySite?.id ?? "not linked"}</span>
          </p>
          <p style={{ margin: 0 }}>
            Coolify project: <span className="tag">{workspace?.coolifyProjectName ?? workspace?.coolifyProjectId ?? coolifySite?.coolifyProjectName ?? "not linked"}</span>
          </p>
          <p style={{ margin: 0 }}>
            Environment: <span className="tag">{workspace?.coolifyEnvironmentName ?? coolifySite?.coolifyEnvironmentName ?? "default"}</span>
          </p>
        </div>
      </article>

      {isWordPress ? (
        <article className="card">
          <h3 className="card-title">WordPress Signals</h3>
          <div style={{ display: "grid", gap: "0.55rem" }}>
            <p style={{ margin: 0 }}>Plugin updates: not connected</p>
            <p style={{ margin: 0 }}>Core version: not connected</p>
            <p style={{ margin: 0 }}>Maintenance mode: not connected</p>
          </div>
        </article>
      ) : (
        <article className="card">
          <h3 className="card-title">No active integrations</h3>
          <p className="card-muted">Attach provider tooling here as this app stack grows.</p>
        </article>
      )}

      <article className="card">
        <h3 className="card-title">Recent Integration Events</h3>
        {activity.length === 0 ? (
          <p className="card-muted" style={{ marginBottom: 0 }}>No deployment events available yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.6rem" }}>
            {activity.map((item) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.65rem" }}>
                <p style={{ margin: 0, fontSize: "0.88rem" }}>{item.detail}</p>
                <span className={`status-chip ${item.status}`}>{item.status}</span>
              </div>
            ))}
          </div>
        )}
        <p style={{ margin: "0.8rem 0 0", fontSize: "0.88rem" }}>
          <Link href={`/apps/${siteId}/advanced`} className="action-link">Open advanced diagnostics</Link>
        </p>
      </article>
    </div>
  );
}
