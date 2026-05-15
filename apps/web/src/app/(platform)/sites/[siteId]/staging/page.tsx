import { getCoolifyOverview } from "@/lib/coolify";
import DeployButton from "@/components/DeployButton";
import { getSiteWorkspace } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

export default async function StagingPage({ params }: Params) {
  const { siteId } = await params;
  const [overview, workspace] = await Promise.all([
    getCoolifyOverview(),
    getSiteWorkspace(siteId)
  ]);

  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const isWordPress = workspace?.siteType === "wordpress";
  const stagingEnabled = Boolean(workspace?.stagingEnabled);

  return (
    <div className="page-stack">
      {/* Top toggle section */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Staging Environment</h3>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
              Enable staging to manage a validation environment before publishing to production.
            </p>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input type="checkbox" checked={stagingEnabled} disabled style={{ width: "18px", height: "18px" }} />
            <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
              {stagingEnabled ? "Enabled" : "Disabled"}
            </span>
          </label>
        </div>
      </div>

      {stagingEnabled ? (
        <>
          {/* Main Flywheel-style layout: left actions, right status */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "1rem", marginBottom: "1.5rem" }}>
            {/* LEFT: Actions and Workflows */}
            <div>
              {/* Go Live / Promote Section */}
              <article className="card" style={{ marginBottom: "1.5rem" }}>
                <div style={{ marginBottom: "1rem" }}>
                  <h3 className="card-title" style={{ margin: 0 }}>Go Live!</h3>
                  <p className="card-muted" style={{ margin: "0.35rem 0 0", fontSize: "0.9rem" }}>
                    Move staging changes to live site
                  </p>
                </div>
                <div
                  style={{
                    padding: "1rem",
                    background: "var(--surface-alt)",
                    borderRadius: "8px",
                    marginBottom: "1rem"
                  }}
                >
                  <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--muted)" }}>
                    After validating in staging, deploy changes to production.
                  </p>
                  <DeployButton
                    siteId={siteId}
                    deployTargetId={site?.deployTargetId}
                    environment="production"
                    label="Launch Staging Changes"
                  />
                </div>
              </article>

              {/* Staging Actions */}
              <article className="card" style={{ marginBottom: "1.5rem" }}>
                <h3 className="card-title">Staging Actions</h3>

                <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
                  {/* Sync Staging */}
                  <div>
                    <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem", fontWeight: 500 }}>
                      Sync Production to Staging
                    </p>
                    <p style={{ margin: "0 0 0.6rem", fontSize: "0.85rem", color: "var(--muted)" }}>
                      Copy the latest production state to staging for testing.
                    </p>
                    <DeployButton
                      siteId={siteId}
                      deployTargetId={site?.deployTargetId}
                      environment="staging"
                      label="Sync to Staging"
                    />
                  </div>

                  {/* WordPress-specific actions */}
                  {isWordPress && (
                    <>
                      {/* Flush Cache */}
                      <div style={{ paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
                        <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem", fontWeight: 500 }}>
                          Flush Cache
                        </p>
                        <p style={{ margin: "0 0 0.6rem", fontSize: "0.85rem", color: "var(--muted)" }}>
                          Emptying your staging site's cache
                        </p>
                        <button className="btn btn-secondary" style={{ width: "100%" }}>
                          Flush Cache
                        </button>
                      </div>

                      {/* Reset Login Attempts */}
                      <div style={{ paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
                        <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem", fontWeight: 500 }}>
                          Reset Login Attempts
                        </p>
                        <p style={{ margin: "0 0 0.6rem", fontSize: "0.85rem", color: "var(--muted)" }}>
                          Unlock out when too many failed login attempts? Step the wall.
                        </p>
                        <button className="btn btn-secondary" style={{ width: "100%" }}>
                          Reset Attempts
                        </button>
                      </div>

                      {/* Reset Staging Environment */}
                      <div style={{ paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
                        <p style={{ margin: "0 0 0.4rem", fontSize: "0.9rem", fontWeight: 500 }}>
                          Reset Staging Environment
                        </p>
                        <p style={{ margin: "0 0 0.6rem", fontSize: "0.85rem", color: "var(--muted)" }}>
                          Create a new staging copy of your live site. The current staging site will be lost.
                        </p>
                        <button className="btn btn-secondary" style={{ width: "100%" }}>
                          Reset Staging
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </article>

              {/* Staging Configuration/Options */}
              {isWordPress && (
                <article className="card">
                  <h3 className="card-title">Staging Configuration</h3>

                  <div style={{ marginTop: "0.75rem" }}>
                    {/* Force HTTPS */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem 0", borderBottom: "1px solid var(--border)" }}>
                      <div>
                        <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 500 }}>
                          Force HTTPS
                        </p>
                        <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                          Redirect all requests to use HTTPS
                        </p>
                      </div>
                      <input type="checkbox" style={{ width: "20px", height: "20px" }} disabled />
                    </div>

                    {/* WP_DEBUG */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem 0", borderBottom: "1px solid var(--border)" }}>
                      <div>
                        <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 500 }}>
                          WP_DEBUG
                        </p>
                        <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                          Enable debug mode in WordPress
                        </p>
                      </div>
                      <input type="checkbox" style={{ width: "20px", height: "20px" }} disabled />
                    </div>

                    {/* WP_CACHE */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem 0" }}>
                      <div>
                        <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 500 }}>
                          WP_CACHE
                        </p>
                        <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                          Turn on site caching when appropriate caching plugins to build and control a persistent cache.
                        </p>
                      </div>
                      <input type="checkbox" style={{ width: "20px", height: "20px" }} disabled />
                    </div>
                  </div>
                </article>
              )}
            </div>

            {/* RIGHT: Status sidebar */}
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {/* Staging Status Card */}
              <article className="card">
                <h3 className="card-title" style={{ margin: "0 0 0.75rem" }}>Staging</h3>
                <p style={{ margin: "0 0 0.45rem" }}>
                  Status:{" "}
                  <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`} style={{ display: "inline" }}>
                    {site?.stagingStatus ?? "unknown"}
                  </span>
                </p>
              </article>

              {/* Production Status Card */}
              <article className="card">
                <h3 className="card-title" style={{ margin: "0 0 0.75rem" }}>Production</h3>
                <p style={{ margin: "0 0 0.45rem" }}>
                  Status:{" "}
                  <span className={`status-chip ${site?.productionStatus ?? "unknown"}`} style={{ display: "inline" }}>
                    {site?.productionStatus ?? "unknown"}
                  </span>
                </p>
              </article>

              {/* WordPress Version (if applicable) */}
              {isWordPress && (
                <article className="card">
                  <h3 className="card-title" style={{ margin: "0 0 0.75rem" }}>WordPress</h3>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--muted)" }}>
                    Version information and core updates would appear here.
                  </p>
                </article>
              )}

              {/* Domain Info */}
              <article className="card">
                <h3 className="card-title" style={{ margin: "0 0 0.75rem" }}>Domain</h3>
                <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--muted)" }}>
                  {workspace?.name ?? siteId}
                </p>
              </article>
            </div>
          </div>
        </>
      ) : (
        /* Disabled state */
        <article className="card">
          <p className="card-muted">
            Staging is currently disabled. Enable staging in <a href={`/sites/${siteId}/settings`} style={{ color: "var(--accent-strong)", fontWeight: 600 }}>Site Settings</a> to manage staging workflows and validation environments.
          </p>
        </article>
      )}

      {/* Developer Details */}
      <article className="card" style={{ marginTop: "1.5rem" }}>
        <details>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)", fontWeight: 600 }}>
            Developer Details
          </summary>
          <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem", fontSize: "0.82rem" }}>
            <p style={{ margin: 0 }}>
              <strong>Site Type:</strong> {workspace?.siteType ?? "unknown"}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Deploy Target:</strong> {site?.deployTargetId ?? "not available"}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Source:</strong> {workspace?.source ?? "unknown"}
            </p>
          </div>
        </details>
      </article>
    </div>
  );
}
