import { getRuntimeConfigStatus } from "@/lib/runtime-config";

export default function SettingsPage() {
  const runtime = getRuntimeConfigStatus();

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Settings</p>
        <h1 style={{ margin: 0 }}>Platform Settings</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Configure platform-level account, organization, and integration settings.
        </p>
      </div>

      <div className="grid" style={{ marginBottom: "2rem" }}>
        {/* Account Settings */}
        <article className="card">
          <h3 className="card-title">Account</h3>
          <p className="card-muted">Manage your user profile and authentication</p>
          <ul style={{ fontSize: "0.9rem", margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
            <li>Profile information</li>
            <li>Email and password</li>
            <li>Two-factor authentication</li>
          </ul>
        </article>

        {/* API Tokens */}
        <article className="card">
          <h3 className="card-title">API Tokens</h3>
          <p className="card-muted">Manage programmatic access</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Generate and manage API tokens for scripting and integrations.
          </p>
        </article>

        {/* Organizations */}
        <article className="card">
          <h3 className="card-title">Organizations</h3>
          <p className="card-muted">Manage teams and clients</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Create organizations, manage team members, and set team-level permissions.
          </p>
        </article>

        {/* Infrastructure */}
        <article className="card">
          <h3 className="card-title">Coolify Integration</h3>
          <p className="card-muted">Configure Coolify API connection</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Coolify API URL and authentication token (can be overridden per-organization).
          </p>
          <div style={{ marginTop: "1rem", display: "grid", gap: "0.6rem" }}>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Runtime mode: <span className={`status-chip ${runtime.coolifyMode}`}>{runtime.coolifyMode}</span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Base URL: <span className={`status-chip ${runtime.coolifyBaseUrlConfigured ? "healthy" : "unknown"}`}>
                {runtime.coolifyBaseUrlConfigured ? "configured" : "missing"}
              </span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              API token: <span className={`status-chip ${runtime.coolifyTokenConfigured ? "healthy" : "unknown"}`}>
                {runtime.coolifyTokenConfigured ? "configured" : "missing"}
              </span>
            </p>
          </div>
        </article>
      </div>

      <div className="grid">
        <article className="card">
          <h3 className="card-title">System Preferences</h3>
          <ul style={{ fontSize: "0.9rem", margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
            <li>Theme and appearance</li>
            <li>Notification preferences</li>
            <li>Time zone and date format</li>
            <li>Language and localization</li>
          </ul>
        </article>

        <article className="card">
          <h3 className="card-title">Server Runtime</h3>
          <ul style={{ fontSize: "0.9rem", margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
            <li>DATABASE_URL: {runtime.databaseConfigured ? "configured" : "missing"}</li>
            <li>NEXTAUTH_SECRET: {runtime.nextauthSecretConfigured ? "configured" : "missing"}</li>
            <li>Coolify API values stay server-only</li>
          </ul>
        </article>
      </div>
    </div>
  );
}
