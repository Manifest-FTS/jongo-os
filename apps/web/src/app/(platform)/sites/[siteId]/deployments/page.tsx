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
          Track publishing activity and run new deployments.
        </p>
      </div>

      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Publishing Summary</h3>
          <p style={{ margin: "0.35rem 0" }}>
            Recorded deploys: <strong>{siteDeployments.length}</strong>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Mode: <span className="tag" style={{ display: "inline" }}>{overview.mode}</span>
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
            Use staging for validation and production for live publishing.
          </p>
        </article>
      </section>

      <article className="card">
        <h3 className="card-title">Deployment Activity</h3>
        <p className="card-muted">Source mode: {overview.mode}</p>

        {siteDeployments.length === 0 ? (
          <p className="card-muted">No deployments yet. Run your first publish action above.</p>
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
                    {deployment.finishedAt ? `Finished: ${new Date(deployment.finishedAt).toLocaleString()}` : "In progress"}
                  </p>
                </div>
                <span className={`status-chip ${deployment.status}`}>{deployment.status}</span>
              </div>
            ))}
          </div>
        )}

        {siteDeployments.length > 0 && (
          <details style={{ marginTop: "0.9rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
              Developer Details
            </summary>
            <div style={{ marginTop: "0.5rem", display: "grid", gap: "0.3rem" }}>
              {siteDeployments.slice(0, 5).map((deployment) => (
                <p key={`meta-${deployment.id}`} style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)", fontFamily: "monospace" }}>
                  {deployment.id}
                </p>
              ))}
            </div>
          </details>
        )}
      </article>

      <article className="card" style={{ marginTop: "1.5rem" }}>
        <h3 className="card-title">Workflow Notes</h3>
        <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem", fontSize: "0.9rem" }}>
          <li>Stage first, then publish to production.</li>
          <li>Deployment history appears here after each action.</li>
          <li>Technical deployment metadata is available in Developer Details.</li>
        </ul>
      </article>
    </div>
  );
}
