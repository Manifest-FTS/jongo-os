type Params = { params: Promise<{ siteId: string }> };

export default async function SiteSettingsPage({ params }: Params) {
  const { siteId } = await params;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Settings</h2>

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
        </article>
      </div>

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
