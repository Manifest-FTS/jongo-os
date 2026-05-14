import DeployButton from "@/components/DeployButton";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteWorkspace } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

export default async function DeploymentsPage({ params }: Params) {
  const { siteId } = await params;
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);
  const siteDeployments = overview.deployments.filter((item) => item.siteName === site?.name);
  const workspace = await getSiteWorkspace(siteId);

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>
          {workspace?.clientName ?? "Unassigned client"} / {workspace?.name ?? siteId}
        </p>
        <h2 style={{ margin: 0 }}>Deployments</h2>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          History, status, and deploy actions for this site.
        </p>
      </div>

      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Deployment Summary</h3>
          <p style={{ margin: "0.35rem 0" }}>
            Known deployments: <strong>{siteDeployments.length}</strong>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Workspace source: <span className="tag" style={{ display: "inline" }}>{overview.mode}</span>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Current status: <span className={`status-chip ${site?.status ?? "unknown"}`}>{site?.status ?? "unknown"}</span>
          </p>
        </article>

        <article className="card">
          <h3 className="card-title">Quick Actions</h3>
          <div style={{ display: "grid", gap: "0.65rem", marginTop: "0.75rem" }}>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="production" label="Deploy to Production" />
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="staging" label="Sync to Staging" />
          </div>
          <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            These actions reuse the same server-side trigger path and fall back to mock mode when Coolify vars are absent.
          </p>
        </article>
      </section>

      <article className="card">
        <h3 className="card-title">Deployment History</h3>
        <p className="card-muted">Source: {overview.mode}</p>

        {siteDeployments.length === 0 ? (
          <p className="card-muted">No deployments recorded yet for this site.</p>
        ) : (
          <div style={{ marginTop: "1rem", display: "grid", gap: "0.65rem" }}>
            {siteDeployments.map((deployment) => (
              <div
                key={deployment.id}
                style={{
                  padding: "0.85rem 0.9rem",
                  background: "var(--surface-alt)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <div>
                  <p style={{ margin: 0, fontWeight: 500 }}>
                    {deployment.environment === "production" ? "Production" : deployment.environment === "staging" ? "Staging" : "Unknown"}
                  </p>
                  <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                    Deployment ID: {deployment.id.slice(0, 7)}
                  </p>
                  {deployment.finishedAt ? (
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                      Finished: {new Date(deployment.finishedAt).toLocaleString()}
                    </p>
                  ) : null}
                </div>
                <span className={`status-chip ${deployment.status}`}>{deployment.status}</span>
              </div>
            ))}
          </div>
        )}
      </article>

      <article className="card" style={{ marginTop: "1.5rem" }}>
        <h3 className="card-title">Operational Notes</h3>
        <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem", fontSize: "0.9rem" }}>
          <li>Production and staging deploys use the same server-side trigger route.</li>
          <li>When Coolify env vars are missing, deploys stay mock-safe instead of leaking secret requirements to the browser.</li>
          <li>Audit logging is written server-side when a database is available.</li>
        </ul>
      </article>
    </div>
  );
}
