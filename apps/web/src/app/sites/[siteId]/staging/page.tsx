import { getCoolifyOverview } from "../../../../lib/coolify";

type Params = { params: Promise<{ siteId: string }> };

export default async function StagingPage({ params }: Params) {
  const { siteId } = await params;
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Staging</h2>

      <div className="grid" style={{ marginBottom: "2rem" }}>
        {/* Staging Status */}
        <article className="card">
          <h3 className="card-title">Staging Environment</h3>
          <p style={{ margin: "0.35rem 0" }}>
            Status:{" "}
            <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>
              {site?.stagingStatus ?? "unknown"}
            </span>
          </p>
          <p className="card-muted" style={{ marginTop: "0.75rem" }}>
            The staging environment mirrors production for safe testing and validation before deployment.
          </p>
        </article>

        {/* Production Status */}
        <article className="card">
          <h3 className="card-title">Production Environment</h3>
          <p style={{ margin: "0.35rem 0" }}>
            Status:{" "}
            <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>
              {site?.productionStatus ?? "unknown"}
            </span>
          </p>
          <p className="card-muted" style={{ marginTop: "0.75rem" }}>
            Live environment serving real users and traffic.
          </p>
        </article>
      </div>

      {/* Staging Workflows */}
      <article className="card">
        <h3 className="card-title">Staging Workflows</h3>

        <div style={{ marginBottom: "1.5rem" }}>
          <div
            style={{
              padding: "1rem",
              background: "var(--bg-alt)",
              borderRadius: "var(--radius)",
              marginBottom: "1rem"
            }}
          >
            <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem" }}>
              Production → Staging Sync
            </h4>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.9rem", color: "var(--muted)" }}>
              Copy the latest production deployment to staging for validation testing.
            </p>
            <button
              style={{
                padding: "0.5rem 1rem",
                background: "var(--accent)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                fontSize: "0.9rem"
              }}
            >
              Sync to Staging
            </button>
          </div>

          <div
            style={{
              padding: "1rem",
              background: "var(--bg-alt)",
              borderRadius: "var(--radius)"
            }}
          >
            <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem" }}>
              Staging → Production Deploy
            </h4>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.9rem", color: "var(--muted)" }}>
              Promote validated changes from staging to production.
            </p>
            <button
              style={{
                padding: "0.5rem 1rem",
                background: "var(--success, #10b981)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                fontSize: "0.9rem"
              }}
            >
              Deploy to Production
            </button>
          </div>
        </div>
      </article>
    </div>
  );
}
