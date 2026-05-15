import { getRuntimeConfigStatus } from "@/lib/runtime-config";
import OwnershipSyncPanel from "@/components/OwnershipSyncPanel";

export default function SettingsPage() {
  const runtime = getRuntimeConfigStatus();

  return (
    <div>
      <div className="card page-hero" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Settings</p>
        <h1 style={{ margin: 0 }}>Platform Settings</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Configure account, client operations, and platform preferences.
        </p>
        <div className="hero-meta-row">
          <span className="tag">Operational profile</span>
          <span className={`status-chip ${runtime.coolifyMode}`}>Mode {runtime.coolifyMode}</span>
          <span className={`status-chip ${runtime.databaseConfigured ? "healthy" : "unknown"}`}>
            Database {runtime.databaseConfigured ? "ready" : "missing"}
          </span>
        </div>
      </div>

      <div className="grid" style={{ marginBottom: "2rem" }}>
        {/* Account Settings */}
        <article className="card tone-card">
          <h3 className="card-title">Account</h3>
          <p className="card-muted">Manage your profile and sign-in preferences.</p>
          <ul style={{ fontSize: "0.9rem", margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
            <li>Profile information</li>
            <li>Email and password</li>
            <li>Two-factor authentication</li>
          </ul>
        </article>

        {/* API Tokens */}
        <article className="card tone-card">
          <h3 className="card-title">API Tokens</h3>
          <p className="card-muted">Manage automation access.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Generate and manage API tokens for scripting and integrations.
          </p>
        </article>

        <OwnershipSyncPanel />

        {/* Organizations */}
        <article className="card tone-card">
          <h3 className="card-title">Organizations</h3>
          <p className="card-muted">Manage clients and team structure.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Create organizations, manage team members, and set team-level permissions.
          </p>
        </article>

        {/* Integrations */}
        <article className="card tone-card">
          <h3 className="card-title">Publishing Integration</h3>
          <p className="card-muted">Connection status for deployment provider.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Configure provider credentials globally or per client workspace.
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

          <details style={{ marginTop: "0.75rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
              Developer Details
            </summary>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
              Uses Coolify API base URL and token from server environment variables.
            </p>
          </details>
        </article>
      </div>

      <div className="grid">
        <article className="card tone-card">
          <h3 className="card-title">System Preferences</h3>
          <ul style={{ fontSize: "0.9rem", margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
            <li>Theme and appearance</li>
            <li>Notification preferences</li>
            <li>Time zone and date format</li>
            <li>Language and localization</li>
          </ul>
        </article>

        <article className="card tone-card">
          <h3 className="card-title">Developer Details</h3>
          <details>
            <summary style={{ cursor: "pointer", fontSize: "0.9rem", color: "var(--muted)" }}>
              View server runtime checks
            </summary>
            <ul style={{ fontSize: "0.86rem", margin: "0.65rem 0 0", paddingLeft: "1.25rem" }}>
              <li>DATABASE_URL: {runtime.databaseConfigured ? "configured" : "missing"}</li>
              <li>NEXTAUTH_SECRET: {runtime.nextauthSecretConfigured ? "configured" : "missing"}</li>
              <li>Provider integration secrets stay server-only</li>
            </ul>
          </details>
        </article>
      </div>
    </div>
  );
}
