type Params = { params: Promise<{ siteId: string }> };

import DeployButton from "@/components/DeployButton";
import { getSiteWorkspace } from "@/lib/repositories";
import { getCoolifyOverview } from "@/lib/coolify";

export default async function SiteSettingsPage({ params }: Params) {
  const { siteId } = await params;
  const [workspace, overview] = await Promise.all([
    getSiteWorkspace(siteId),
    getCoolifyOverview(),
  ]);
  const site = overview.sites.find((item) => item.id === siteId);

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>
          {workspace?.clientName ?? "Unassigned client"} / {workspace?.name ?? siteId}
        </p>
        <h2 style={{ margin: 0 }}>Settings</h2>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Infrastructure, environment, and access settings for this site.
        </p>
      </div>

      <div className="grid" style={{ marginBottom: "2rem" }}>
        {/* Environment Variables */}
        <article className="card">
          <h3 className="card-title">Environment Variables</h3>
          <p className="card-muted">Configure application environment variables</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Variables are scoped per-environment (production, staging, development).
          </p>
        </article>

        {/* Domain Configuration */}
        <article className="card">
          <h3 className="card-title">Domains</h3>
          <p className="card-muted">Manage custom domains and HTTPS certificates</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Configure primary domain, aliases, and SSL/TLS settings.
          </p>
        </article>

        {/* Backup Configuration */}
        <article className="card">
          <h3 className="card-title">Backups</h3>
          <p className="card-muted">Schedule and manage automated backups</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Configure backup frequency, retention policy, and storage destination.
          </p>
        </article>

        {/* Infrastructure Settings */}
        <article className="card">
          <h3 className="card-title">Infrastructure</h3>
          <p className="card-muted">Coolify-specific configuration</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Service ID, resource allocation, and provider settings.
          </p>
          <div style={{ marginTop: "1rem", display: "grid", gap: "0.45rem" }}>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Current status: <span className={`status-chip ${workspace?.status ?? "unknown"}`}>{workspace?.status ?? "unknown"}</span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Production: <span className={`status-chip ${workspace?.productionStatus ?? "unknown"}`}>{workspace?.productionStatus ?? "unknown"}</span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Staging: <span className={`status-chip ${workspace?.stagingStatus ?? "unknown"}`}>{workspace?.stagingStatus ?? "unknown"}</span>
            </p>
          </div>
        </article>
      </div>

      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 className="card-title">Quick Actions</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="staging" label="Sync to Staging" />
          <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="production" label="Deploy to Production" />
        </div>
        <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          Actions reuse the same server-side deploy path and stay mock-safe when Coolify values are missing.
        </p>
      </article>

      {/* Collaborators */}
      <article className="card">
        <h3 className="card-title">Collaborators</h3>
        <p className="card-muted">Manage team access and permissions</p>
        <div style={{ marginTop: "1rem" }}>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <strong>Roles:</strong> Owner, Admin, Operator, Viewer
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Add team members and assign role-based access control at site scope.
          </p>
        </div>
      </article>

      {/* Advanced Settings */}
      <article className="card" style={{ marginTop: "1.5rem" }}>
        <h3 className="card-title">Advanced</h3>
        <p className="card-muted">Advanced operational settings</p>
        <div style={{ marginTop: "1rem" }}>
          <button
            style={{
              padding: "0.5rem 1rem",
              background: "var(--danger, #ef4444)",
              color: "white",
              border: "none",
              borderRadius: "var(--radius)",
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Delete Site
          </button>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
            Permanently remove this site and all associated data.
          </p>
        </div>
      </article>
    </div>
  );
}
