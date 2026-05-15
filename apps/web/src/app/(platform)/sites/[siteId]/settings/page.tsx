type Params = { params: Promise<{ siteId: string }> };

import Link from "next/link";
import DeployButton from "@/components/DeployButton";
import SiteInfoForm from "@/components/SiteInfoForm";
import { getSiteWorkspace } from "@/lib/repositories";
import { getCoolifyOverview } from "@/lib/coolify";
import { ArrowRightIcon } from "@/components/JongoIcons";

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
          Manage publishing, site health, backups, and team access.
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
              coolifyProjectId: workspace.coolifyProjectId,
              stagingEnabled: workspace.stagingEnabled,
              gitRepositoryUrl: workspace.gitRepositoryUrl
            }}
          />
        </article>
      )}

      {workspace?.ownershipState !== "mapped" && (
        <div className="diagnostic-banner" style={{ marginBottom: "1rem" }}>
          <strong>Ownership mapping needs attention.</strong> This resource is not mapped to a Client via Coolify Project ownership yet.
          Map a Coolify Project ID in Site Information to avoid orphaned resources.
        </div>
      )}

      <div className="grid" style={{ marginBottom: "2rem" }}>
        {/* Environment Variables */}
        <article className="card">
          <h3 className="card-title">Publishing</h3>
          <p className="card-muted">Manage release behavior across production and staging.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Environment-specific variables are available under Developer Details.
          </p>
        </article>

        {/* Domain Configuration */}
        <article className="card">
          <h3 className="card-title">Domains</h3>
          <p className="card-muted">Manage site domains and SSL certificates.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Set your primary domain, aliases, and secure routing.
          </p>
        </article>

        {/* Backup Configuration */}
        <article className="card">
          <h3 className="card-title">Backups</h3>
          <p className="card-muted">Protect content with automated backups.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Configure cadence, retention, and recovery expectations.
          </p>
        </article>

        {/* Infrastructure Status */}
        <article className="card">
          <h3 className="card-title">Site Health</h3>
          <p className="card-muted">Current operational status for this site.</p>
          <div style={{ marginTop: "1rem", display: "grid", gap: "0.45rem" }}>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Source: <span className="tag">{workspace?.source === "db" ? "managed" : "external"}</span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Ownership: <span className="tag">{workspace?.ownershipState ?? "unavailable"}</span>
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
            <details style={{ marginTop: "0.35rem" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
                Developer Details
              </summary>
              <div style={{ marginTop: "0.45rem", display: "grid", gap: "0.35rem" }}>
                {workspace?.coolifyServiceUuid && (
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)", fontFamily: "monospace", wordBreak: "break-all" }}>
                    Coolify UUID: {workspace.coolifyServiceUuid}
                  </p>
                )}
                {workspace?.coolifyProjectId && (
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)", fontFamily: "monospace", wordBreak: "break-all" }}>
                    Coolify Project ID: {workspace.coolifyProjectId}
                  </p>
                )}
                {workspace?.coolifyProjectName && (
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
                    Coolify Project Name: {workspace.coolifyProjectName}
                  </p>
                )}
                {workspace?.gitRepositoryUrl && (
                  <p style={{ margin: 0, fontSize: "0.82rem" }}>
                    <a href={workspace.gitRepositoryUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                      Repository: {workspace.gitRepositoryUrl}
                    </a>
                  </p>
                )}
              </div>
            </details>
          </div>
        </article>
      </div>

      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 className="card-title">Publishing Actions</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId ?? workspace?.deployTargetId} environment="staging" label="Sync to Staging" />
          <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId ?? workspace?.deployTargetId} environment="production" label="Deploy to Production" />
        </div>
        <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          Actions reuse the same server-side deploy path and stay mock-safe when Coolify values are missing.
        </p>
      </article>

      {/* Collaborators - managed via org membership */}
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
          {workspace?.ownershipState === "mapped" && (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
              <Link href={`/organizations/${workspace.clientId}`} className="action-link">
                Manage {workspace.clientName} collaborators <ArrowRightIcon className="btn-icon" />
              </Link>
            </p>
          )}
        </div>
      </article>
    </div>
  );
}
