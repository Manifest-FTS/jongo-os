type Params = { params: Promise<{ siteId: string }> };

import DeployButton from "@/components/DeployButton";
import SiteInfoForm from "@/components/SiteInfoForm";
import { getSiteWorkspace } from "@/lib/repositories";
import { getCoolifyOverview } from "@/lib/coolify";

export default async function SiteSettingsPage({ params }: Params) {
  const { siteId } = await params;
  const [workspace, overview] = await Promise.all([
    getSiteWorkspace(siteId),
    getCoolifyOverview()
  ]);
  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);

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

      {/* Site Record (DB-backed sites only) */}
      {workspace?.source === "db" && (
        <article className="card" style={{ marginBottom: "1.5rem" }}>
          <h3 className="card-title">Site Information</h3>
          <p className="card-muted" style={{ marginBottom: "1rem" }}>Update name, description, and infrastructure links.</p>
          <SiteInfoForm
            siteId={siteId}
            initial={{
              name: workspace.name,
              description: workspace.description,
              coolifyServiceUuid: workspace.coolifyServiceUuid,
              gitRepositoryUrl: workspace.gitRepositoryUrl
            }}
          />
        </article>
      )}

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

        {/* Infrastructure Status */}
        <article className="card">
          <h3 className="card-title">Infrastructure</h3>
          <p className="card-muted">Coolify connection status</p>
          <div style={{ marginTop: "1rem", display: "grid", gap: "0.45rem" }}>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Source: <span className="tag">{workspace?.source ?? "coolify"}</span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Overall: <span className={`status-chip ${workspace?.status ?? "unknown"}`}>{workspace?.status ?? "unknown"}</span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Production: <span className={`status-chip ${workspace?.productionStatus ?? "unknown"}`}>{workspace?.productionStatus ?? "unknown"}</span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Staging: <span className={`status-chip ${workspace?.stagingStatus ?? "unknown"}`}>{workspace?.stagingStatus ?? "unknown"}</span>
            </p>
            {workspace?.coolifyServiceUuid && (
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--muted)", fontFamily: "monospace", wordBreak: "break-all" }}>
                UUID: {workspace.coolifyServiceUuid}
              </p>
            )}
            {workspace?.gitRepositoryUrl && (
              <p style={{ margin: 0, fontSize: "0.85rem" }}>
                <a href={workspace.gitRepositoryUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                  {workspace.gitRepositoryUrl}
                </a>
              </p>
            )}
          </div>
        </article>
      </div>

      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 className="card-title">Quick Actions</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId ?? workspace?.deployTargetId} environment="staging" label="Sync to Staging" />
          <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId ?? workspace?.deployTargetId} environment="production" label="Deploy to Production" />
        </div>
        <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          Actions reuse the same server-side deploy path and stay mock-safe when Coolify values are missing.
        </p>
      </article>

      {/* Collaborators — managed via org membership */}
      <article className="card">
        <h3 className="card-title">Collaborators</h3>
        <p className="card-muted">Manage team access and permissions</p>
        <div style={{ marginTop: "1rem" }}>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <strong>Roles:</strong> Owner, Admin, Operator, Viewer
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Organization-level collaborators inherit access to all sites in that org.
            Site-specific overrides will be available in a future update.
          </p>
          {workspace?.clientId && workspace.clientId !== "unassigned" && (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
              <a href={`/organizations/${workspace.clientId}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                → Manage {workspace.clientName} collaborators
              </a>
            </p>
          )}
        </div>
      </article>
    </div>
  );
}
