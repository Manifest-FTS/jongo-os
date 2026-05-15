import { getCoolifyOverview } from "@/lib/coolify";
import DeployButton from "@/components/DeployButton";
import { getSiteWorkspace } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

export default async function StagingPage({ params }: Params) {
  const { siteId } = await params;
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);
  const workspace = await getSiteWorkspace(siteId);

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>
          {workspace?.clientName ?? "Unassigned client"} / {workspace?.name ?? siteId}
        </p>
        <h2 style={{ margin: 0 }}>Staging</h2>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Validate changes before publishing to production.
        </p>
      </div>

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
            Use staging for QA and content checks before live publishing.
          </p>
          <div style={{ marginTop: "1rem" }}>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="staging" label="Sync to Staging" />
          </div>
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
            Live environment serving clients and visitors.
          </p>
          <div style={{ marginTop: "1rem" }}>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="production" label="Deploy to Production" />
          </div>
        </article>
      </div>

      {/* Staging Workflows */}
      <article className="card">
        <h3 className="card-title">Publishing Workflow</h3>
        <p className="card-muted" style={{ marginTop: 0 }}>
          Source: {overview.mode} - {workspace?.deploymentCount ?? 0} known deployments
        </p>

        <div style={{ marginBottom: "1.5rem" }}>
          <div
            style={{
              padding: "1rem",
              background: "var(--surface-alt)",
              borderRadius: "8px",
              marginBottom: "1rem"
            }}
          >
            <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem" }}>
              Production to Staging Sync
            </h4>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.9rem", color: "var(--muted)" }}>
              Copy the latest production state to staging for validation.
            </p>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="staging" label="Sync to Staging" />
          </div>

          <div
            style={{
              padding: "1rem",
              background: "var(--surface-alt)",
              borderRadius: "8px"
            }}
          >
            <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem" }}>
              Staging to Production Publish
            </h4>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.9rem", color: "var(--muted)" }}>
              Promote validated changes to production.
            </p>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="production" label="Deploy to Production" />
          </div>
        </div>
      </article>

      {workspace?.recentActivity?.length ? (
        <article className="card" style={{ marginTop: "1.5rem" }}>
          <h3 className="card-title">Recent Activity</h3>
          <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem", fontSize: "0.9rem" }}>
            {workspace.recentActivity.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      ) : null}

      <article className="card" style={{ marginTop: "1.5rem" }}>
        <h3 className="card-title">Developer Details</h3>
        <details>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
            View technical deployment context
          </summary>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
            Deploy target: {site?.deployTargetId ?? "not available"}
          </p>
        </details>
      </article>
    </div>
  );
}
