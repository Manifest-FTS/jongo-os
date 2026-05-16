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
          Manage publishing and app configuration.
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
        <article className="card">
          <h3 className="card-title">Publishing</h3>
          <p className="card-muted">Manage release behavior across production and staging.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Environment-specific infrastructure fields are available in the Advanced tab.
          </p>
        </article>

        <article className="card">
          <h3 className="card-title">Domains</h3>
          <p className="card-muted">Manage site domains and SSL certificates.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Set your primary domain, aliases, and secure routing.
          </p>
        </article>

        <article className="card">
          <h3 className="card-title">Backups</h3>
          <p className="card-muted">Protect content with automated backups.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Configure cadence, retention, and recovery expectations.
          </p>
        </article>

        <article className="card">
          <h3 className="card-title">App Health</h3>
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
    </div>
  );
}
