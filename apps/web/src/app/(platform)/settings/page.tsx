import { getRuntimeConfigStatus } from "@/lib/runtime-config";
import EmailTestPanel from "@/components/EmailTestPanel";
import OwnershipSyncPanel from "@/components/OwnershipSyncPanel";
import { auth } from "@/lib/auth.config";
import { canAccessRuntimeDiagnostics, runRuntimeDiagnosticsProbe } from "@/lib/runtime-diagnostics";
import PendingBadge from "@/components/PendingBadge";

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

export default async function SettingsPage() {
  const session = await auth();
  const runtime = getRuntimeConfigStatus();
  const sessionEmail = normalizeEmail(session?.user?.email);
  const bootstrapAdminEmail = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const isAdmin = Boolean(bootstrapAdminEmail && sessionEmail === bootstrapAdminEmail);
  const canViewDiagnostics = canAccessRuntimeDiagnostics({ sessionEmail: session?.user?.email });
  const diagnostics = canViewDiagnostics ? await runRuntimeDiagnosticsProbe() : null;
  const recentRepoCall = diagnostics?.repositoryCalls[diagnostics.repositoryCalls.length - 1];
  const recentInventory = diagnostics?.coolifyInventoryHistory[diagnostics.coolifyInventoryHistory.length - 1];
  const recentEndpointCalls = diagnostics?.coolifyEndpointCalls.slice(-8).reverse() ?? [];

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
          <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            Account <PendingBadge reason="Account profile management is not yet available. Sign-in is handled via the authentication provider." />
          </h3>
          <p className="card-muted">Manage your profile and sign-in preferences.</p>
          <ul style={{ fontSize: "0.9rem", margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
            <li>Profile information</li>
            <li>Email and password</li>
            <li>Two-factor authentication</li>
          </ul>
        </article>

        {/* API Tokens */}
        <article className="card tone-card">
          <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            API Tokens <PendingBadge reason="API token management is not yet available. Tokens for scripting and integrations will be generated here." />
          </h3>
          <p className="card-muted">Manage automation access.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Generate and manage API tokens for scripting and integrations.
          </p>
        </article>

        {isAdmin ? <OwnershipSyncPanel /> : null}

        {/* Organizations */}
        <article className="card tone-card">
          <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            Organizations <PendingBadge reason="Organization-level settings will be surfaced here. Manage clients from the Clients directory for now." />
          </h3>
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

        <article className="card tone-card">
          <h3 className="card-title">Email Delivery</h3>
          <p className="card-muted">Invite and transactional email configuration status.</p>
          <div style={{ marginTop: "0.8rem", display: "grid", gap: "0.55rem" }}>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Provider mode:{" "}
              <span className={`status-chip ${runtime.emailConfigured ? "healthy" : "unknown"}`}>
                {runtime.emailProviderMode === "disabled"
                  ? "Disabled"
                  : runtime.emailProviderMode === "smtp2go_api"
                  ? "SMTP2GO API"
                  : "Generic SMTP"}
              </span>
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Status:{" "}
              <span className={`status-chip ${runtime.emailConfigured ? "healthy" : "unknown"}`}>
                {runtime.emailConfigured ? "configured" : "not configured"}
              </span>
            </p>
            <p style={{ margin: 0, fontSize: "0.84rem", color: "var(--muted)" }}>
              {runtime.emailConfigured
                ? "Email sending is enabled. Secret values remain server-side and are never shown in this UI."
                : "Email delivery is disabled. Invite links still work via manual copy/share fallback."}
            </p>
            <p style={{ margin: 0, fontSize: "0.84rem", color: "var(--muted)" }}>
              Supported modes: Disabled, Generic SMTP (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM), SMTP2GO API (SMTP2GO_API_KEY/SMTP_FROM).
            </p>
          </div>

          {canViewDiagnostics ? (
            <EmailTestPanel />
          ) : (
            <p className="card-muted" style={{ marginTop: "0.8rem" }}>
              Test email action is available to admin/dev diagnostics users.
            </p>
          )}
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

          {canViewDiagnostics && diagnostics ? (
            <details style={{ marginTop: "0.8rem" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.9rem", color: "var(--muted)" }}>
                Runtime diagnostics (admin/dev)
              </summary>

              <div style={{ marginTop: "0.65rem", display: "grid", gap: "0.5rem", fontSize: "0.85rem" }}>
                <p style={{ margin: 0 }}>
                  Last successful Coolify inventory fetch: {diagnostics.lastSuccessfulCoolifyInventoryFetchAt ?? "never"}
                </p>
                <p style={{ margin: 0 }}>
                  Last non-empty Coolify inventory fetch: {diagnostics.lastNonEmptyCoolifyInventoryFetchAt ?? "never"}
                </p>
                <p style={{ margin: 0 }}>
                  Latest inventory source: {recentInventory ? `${recentInventory.source} (${recentInventory.mode})` : "n/a"}
                </p>
                <p style={{ margin: 0 }}>
                  Latest repo source decision: {recentRepoCall ? `${recentRepoCall.operation} -> ${recentRepoCall.source}` : "n/a"}
                </p>
                <p style={{ margin: 0 }}>
                  Scope applied: {recentRepoCall?.scopeApplied ? "yes" : "no"}
                </p>
                <p style={{ margin: 0 }}>
                  Env presence: DATABASE_URL={diagnostics.envPresence.databaseUrl ? "yes" : "no"}, COOLIFY_API_BASE_URL={diagnostics.envPresence.coolifyApiBaseUrl ? "yes" : "no"}, COOLIFY_API_TOKEN={diagnostics.envPresence.coolifyApiToken ? "yes" : "no"}, NEXTAUTH_SECRET={diagnostics.envPresence.nextauthSecret ? "yes" : "no"}
                </p>
              </div>

              <div style={{ marginTop: "0.65rem", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Endpoint</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Status</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Success</th>
                      <th style={{ textAlign: "left", padding: "0.35rem" }}>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentEndpointCalls.map((call, idx) => (
                      <tr key={`${call.at}-${call.path}-${idx}`}>
                        <td style={{ padding: "0.35rem" }}>{call.path}</td>
                        <td style={{ padding: "0.35rem" }}>{call.statusCode ?? "n/a"}</td>
                        <td style={{ padding: "0.35rem" }}>{call.success ? "yes" : "no"}</td>
                        <td style={{ padding: "0.35rem" }}>{call.responseCount ?? "n/a"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p style={{ marginTop: "0.65rem", marginBottom: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
                Full JSON is available at /api/diagnostics/runtime?probe=1 for authorized admin/dev access.
              </p>

              <EmailTestPanel />
            </details>
          ) : null}
        </article>

        {!isAdmin ? (
          <article className="card tone-card">
            <h3 className="card-title">Admin-only Controls</h3>
            <p className="card-muted" style={{ margin: 0 }}>
              Ownership sync and infrastructure diagnostics are visible only to platform admins.
            </p>
          </article>
        ) : null}
      </div>
    </div>
  );
}
