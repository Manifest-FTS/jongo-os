import { getCoolifyAppBackupInventory } from "@/lib/coolify";
import { getSiteWorkspace } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function BackupsPage({ params }: Params) {
  const { siteId } = await params;
  const workspace = await getSiteWorkspace(siteId);

  const appUuid = workspace?.coolifyServiceUuid;
  const inventory = appUuid ? await getCoolifyAppBackupInventory(appUuid) : null;

  const isConfigured = inventory?.configured ?? false;
  const hasLiveData = inventory?.source === "live";
  const enabledSchedules = inventory?.schedules.filter((s) => s.enabled) ?? [];
  const recentExecutions = inventory?.recentExecutions ?? [];

  const protectionStatus = !hasLiveData ? "unknown" : isConfigured ? "protected" : "unprotected";

  return (
    <div className="page-stack">
      <article className="card">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: "0.35rem" }}>Backups</h2>
            <p className="card-muted" style={{ margin: 0 }}>
              Automated backup schedules and execution history for this app&apos;s databases.
            </p>
          </div>
          <span className={`status-chip ${protectionStatus === "protected" ? "healthy" : protectionStatus === "unprotected" ? "degraded" : "unknown"}`}>
            {protectionStatus === "protected" ? "Protected" : protectionStatus === "unprotected" ? "Not protected" : "Status unknown"}
          </span>
        </div>
      </article>

      {!appUuid ? (
        <article className="card">
          <h3 className="card-title">No Coolify resource linked</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>
            Link a Coolify application UUID in Settings to view backup status.
          </p>
        </article>
      ) : !hasLiveData ? (
        <article className="card">
          <h3 className="card-title">Backup data unavailable</h3>
          <p className="card-muted">
            Could not retrieve backup information from Coolify. The API may be unreachable or this resource type may not expose backup config.
          </p>
          {inventory?.note ? (
            <p className="card-muted" style={{ marginBottom: 0 }}>
              Reason: <code>{inventory.note}</code>
            </p>
          ) : null}
        </article>
      ) : !isConfigured ? (
        <article className="card">
          <h3 className="card-title" style={{ color: "var(--warning, #d97706)" }}>Backups not configured</h3>
          <p className="card-muted">No active backup schedules were found for databases attached to this application.</p>
          <p className="card-muted" style={{ marginBottom: 0 }}>
            {inventory?.note === "no_databases_in_environment"
              ? "No databases were detected in this application's Coolify environment."
              : "Contact your platform administrator to configure automated database backups via Coolify."}
          </p>
        </article>
      ) : null}

      {enabledSchedules.length > 0 ? (
        <article className="card">
          <h3 className="card-title">Active Backup Schedules</h3>
          <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.5rem" }}>
            {enabledSchedules.map((schedule) => (
              <div key={schedule.id} style={{ padding: "0.75rem", background: "var(--surface-alt)", borderRadius: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
                  <div>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: "0.9rem" }}>{schedule.resourceName}</p>
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                      {schedule.frequency ? `Schedule: ${schedule.frequency}` : "Schedule: custom"}
                    </p>
                  </div>
                  <span className="status-chip healthy">enabled</span>
                </div>
                <div style={{ marginTop: "0.5rem", display: "flex", gap: "1.25rem", fontSize: "0.82rem", color: "var(--muted)" }}>
                  {schedule.retentionAmount != null ? <span>Retention: {schedule.retentionAmount} backups</span> : null}
                  {schedule.retentionDays != null ? <span>{schedule.retentionDays} days</span> : null}
                </div>
              </div>
            ))}
          </div>
        </article>
      ) : null}

      {hasLiveData ? (
        <article className="card">
          <h3 className="card-title">Recent Backup Executions</h3>
          {recentExecutions.length === 0 ? (
            <p className="card-muted" style={{ marginBottom: 0 }}>No backup execution records found.</p>
          ) : (
            <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
              {recentExecutions.map((exec) => (
                <div key={exec.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.65rem" }}>
                  <div>
                    <p style={{ margin: 0, fontSize: "0.88rem" }}>
                      {exec.finishedAt
                        ? formatRelativeTime(exec.finishedAt)
                        : exec.startedAt
                          ? formatRelativeTime(exec.startedAt)
                          : "unknown time"}
                    </p>
                    {exec.filename ? (
                      <p style={{ margin: "0.1rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>{exec.filename}</p>
                    ) : null}
                  </div>
                  <span className={`status-chip ${exec.status === "success" ? "healthy" : exec.status === "failed" ? "error" : "unknown"}`}>
                    {exec.status}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.82rem" }}>
            Restore operations must be performed via the Coolify dashboard by a platform administrator.
          </p>
        </article>
      ) : null}

      <article className="card">
        <h3 className="card-title">Backup Policy</h3>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Backup configuration and restoration are managed through Coolify. Contact your platform administrator to change schedules, retention policies, or to initiate a recovery.
        </p>
      </article>
    </div>
  );
}
