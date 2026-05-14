import { getCoolifyOverview } from "../../../../lib/coolify";

type Params = { params: Promise<{ siteId: string }> };

export default async function DeploymentsPage({ params }: Params) {
  const { siteId } = await params;
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);
  const siteDeployments = overview.deployments.filter((item) => item.siteName === site?.name);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Deployments</h2>

      <article className="card">
        <h3 className="card-title">Deployment History</h3>
        <p className="card-muted">Source: {overview.mode}</p>

        {siteDeployments.length === 0 ? (
          <p className="card-muted">No deployments recorded yet for this site.</p>
        ) : (
          <div style={{ marginTop: "1rem" }}>
            {siteDeployments.map((deployment) => (
              <div
                key={deployment.id}
                style={{
                  padding: "0.75rem",
                  marginBottom: "0.5rem",
                  background: "var(--bg-alt)",
                  borderRadius: "var(--radius)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <div>
                  <p style={{ margin: 0, fontWeight: 500 }}>
                    {deployment.environment === "production" ? "🚀" : "📦"} {deployment.environment}
                  </p>
                  <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                    {deployment.id.slice(0, 7)}
                  </p>
                </div>
                <span className={`status-chip ${deployment.status}`}>{deployment.status}</span>
              </div>
            ))}
          </div>
        )}
      </article>

      <article className="card" style={{ marginTop: "1.5rem" }}>
        <h3 className="card-title">Quick Actions</h3>
        <button
          style={{
            padding: "0.5rem 1rem",
            background: "var(--accent)",
            color: "white",
            border: "none",
            borderRadius: "var(--radius)",
            cursor: "pointer"
          }}
        >
          Deploy Now
        </button>
        <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "0.5rem" }}>
          Trigger a new deployment to production
        </p>
      </article>
    </div>
  );
}
