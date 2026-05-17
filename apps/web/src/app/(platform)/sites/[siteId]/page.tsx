import { getCoolifyOverview } from "@/lib/coolify";
import { getActivityFeedEmptyMessage } from "@/lib/reason-messages";
import DeployButton from "@/components/DeployButton";
import { getSiteActivityFeed, getSiteWorkspace } from "@/lib/repositories";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/JongoIcons";
import PendingBadge from "@/components/PendingBadge";

type Params = { params: Promise<{ siteId: string }> };

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function SiteOverviewPage({ params }: Params) {
  const { siteId } = await params;
  const [overview, workspace, siteActivity] = await Promise.all([
    getCoolifyOverview(),
    getSiteWorkspace(siteId),
    getSiteActivityFeed(siteId)
  ]);
  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const isWordPress = workspace?.siteType === "wordpress";

  return (
    <div>
      <div className="grid" style={{ marginBottom: "1rem" }}>
        {/* Site Health */}
        <article className="card">
          <h3 className="card-title">Site Health</h3>
          <p style={{ margin: "0.35rem 0" }}>
            Production:{" "}
            <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>
              {site?.productionStatus ?? "unknown"}
            </span>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Staging:{" "}
            <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>
              {site?.stagingStatus ?? "unknown"}
            </span>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Overall:{" "}
            <span className={`status-chip ${site?.status ?? "unknown"}`}>
              {site?.status ?? "unknown"}
            </span>
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.85rem" }}>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="production" />
            {workspace?.stagingEnabled && (
              <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="staging" />
            )}
          </div>
          <p style={{ margin: "0.55rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
            {overview.mode === "live"
              ? <>Coolify · {formatAgo(overview.generatedAt)}{overview.fetchError && <span style={{ color: "var(--error, #c0392b)", marginLeft: "0.3rem" }}>· unavailable</span>}</>
              : "Demo mode — live data requires Coolify config"}
          </p>
        </article>

        {/* Publishing */}
        <article className="card">
          <h3 className="card-title">Publishing</h3>
          <p className="card-muted">Move changes safely from staging to production.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Use staging sync for review, then promote when ready.
          </p>
          <p style={{ margin: "0.75rem 0 0" }}>
            <Link href={`/apps/${siteId}/staging`} className="action-link">
              Open publishing workflow <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>

        <article className="card">
          <h3 className="card-title">Team</h3>
          <p className="card-muted">Team management lives in the dedicated Team tab.</p>
          <p style={{ margin: "0.75rem 0 0" }}>
            <Link href={`/apps/${siteId}/team`} className="action-link">
              Open app team <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>
      </div>

      {/* WordPress context - shown only when site type is detected as WordPress */}
      {isWordPress && (
        <div style={{ marginBottom: "1rem" }}>
          <article className="card">
            <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              WordPress Overview
              <span className="status-chip unknown" style={{ fontSize: "0.7rem" }}>WP detected</span>
              <PendingBadge reason="WordPress REST API is not yet connected. Add WP_API_URL to site environment variables to unlock live version, plugin, and maintenance data." />
            </h3>
            <div className="grid" style={{ marginTop: "0.5rem" }}>
              <div>
                <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", fontWeight: 500 }}>Core Version</p>
                <p className="card-muted" style={{ margin: 0 }}>Connect WordPress REST API to show version</p>
              </div>
              <div>
                <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", fontWeight: 500 }}>Plugin Updates</p>
                <p className="card-muted" style={{ margin: 0 }}>Connect WordPress REST API to show pending updates</p>
              </div>
              <div>
                <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", fontWeight: 500 }}>Maintenance Mode</p>
                <p className="card-muted" style={{ margin: 0 }}>Enable WP API settings to control maintenance mode</p>
              </div>
            </div>
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
              Add <code>WP_API_URL</code> to site environment variables to unlock WordPress operational data.
            </p>
          </article>
        </div>
      )}

      <div style={{ display: "grid", gap: "1rem", marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Activity Feed</h3>
          {siteActivity.length === 0 ? (
            <p className="card-muted" style={{ marginBottom: 0 }}>
              {getActivityFeedEmptyMessage(!site, Boolean(overview.fetchError))}
            </p>
          ) : (
            <div style={{ marginTop: "0.5rem", display: "grid", gap: "0.55rem" }}>
              {siteActivity.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    paddingBottom: "0.5rem",
                    borderBottom: "1px solid var(--border)"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 500 }}>{item.title}</p>
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                      {item.detail}
                      {item.durationSeconds !== undefined && ` - ${formatDuration(item.durationSeconds)}`}
                      {item.timestamp ? ` - ${new Date(item.timestamp).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: "0.35rem", marginLeft: "0.75rem", flexShrink: 0 }}>
                    {item.environment && item.environment !== "unknown" && (
                      <span className="status-chip unknown" style={{ fontSize: "0.72rem" }}>{item.environment}</span>
                    )}
                    <span className={`status-chip ${item.status}`}>{item.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>

      <div className="grid">
        {/* Backups */}
        <article className="card">
          <h3 className="card-title">Backups</h3>
          <p className="card-muted">Protect site data with routine backups.</p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Configure schedule and retention in site settings.
          </p>
        </article>

        {/* Environments */}
        <article className="card">
          <h3 className="card-title">Environments</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Production, Staging, Development
          </p>
          <p style={{ fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/settings`} className="action-link">
              Configure environments <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>

        {/* Next Steps */}
        <article className="card">
          <h3 className="card-title">What to do next</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/analytics`} className="action-link">
              Review deployment analytics <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/staging`} className="action-link">
              Run publishing workflow <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/settings`} className="action-link">
              Update site settings <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>
      </div>

      <article className="card" style={{ marginTop: "1rem" }}>
        <h3 className="card-title">Need Infrastructure Details?</h3>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Use the Advanced tab for diagnostics and provider-level metadata.
        </p>
      </article>
    </div>
  );
}

