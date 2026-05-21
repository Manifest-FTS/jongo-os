import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";
import {
  formatWordPressCollectorStatus,
  formatWordPressTelemetrySource,
  formatWordPressTelemetryValue,
  getWordPressTelemetryFreshness
} from "@/lib/wordpress-telemetry";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

export default async function SitePluginsPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace) {
    notFound();
  }
  const canViewInternalMetadata = Boolean(
    session?.user?.id &&
    workspace.organizationId &&
    await isClientAdmin(workspace.organizationId, session.user.id)
  );

  const isWordPress = workspace.siteType === "wordpress";
  if (!isWordPress) {
    return (
      <div className="page-stack">
        <article className="card">
          <h2 style={{ marginTop: 0 }}>Plugin Stats</h2>
          <p className="card-muted">Plugin stats are available only for WordPress app types.</p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.88rem" }}>
            <Link href={`/apps/${siteId}/integrations`} className="action-link">Open integrations</Link>
          </p>
        </article>
      </div>
    );
  }

  const resolvedSiteId = workspace.slug ?? workspace.id ?? siteId;
  const snapshot = await getWordPressTelemetrySnapshotForRequest({
    siteId: resolvedSiteId,
    isWordPress,
    hasCoolifyServiceUuid: Boolean(workspace.coolifyServiceUuid)
  });
  const policy = snapshot.policy;
  const freshness = getWordPressTelemetryFreshness(snapshot.checkedAt);
  const collectorConfigured = Boolean(process.env.WORDPRESS_TELEMETRY_COLLECTOR_URL?.trim());
  const collectorDiagnostic = !collectorConfigured
    ? "Collector endpoint is not configured."
    : snapshot.source === "collector"
      ? "Collector response is active."
      : "Collector is configured, but this snapshot is currently using fallback policy data.";
  const renderMetric = (value: number | null) => (value == null ? "Not available yet" : String(value));

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Plugin Stats</h2>
        <p className="card-muted">WordPress plugin monitoring summary for this app.</p>
      </article>

      <div className="grid">
        <article className="card">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>Plugin status</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "1.05rem", fontWeight: 600 }}>{formatWordPressTelemetryValue(policy.signals.pluginStatus)}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>Update availability</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "1.05rem", fontWeight: 600 }}>{formatWordPressTelemetryValue(policy.signals.updateAvailability)}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>Monitoring status</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "1.05rem", fontWeight: 600 }}>{formatWordPressCollectorStatus(policy.collectorStatus)}</p>
        </article>
      </div>

      <article className="card">
        <h3 className="card-title">Monitoring Update</h3>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Last updated: {new Date(snapshot.checkedAt).toLocaleString()}
        </p>
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
          {freshness.label}
          {freshness.isStale ? " - data may be out of date" : ""}
        </p>
        {canViewInternalMetadata ? (
          <details style={{ marginTop: "0.4rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.78rem", color: "var(--muted)" }}>
              Technical details
            </summary>
            <div style={{ marginTop: "0.4rem", display: "grid", gap: "0.25rem" }}>
              <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)" }}>
                Data source: {formatWordPressTelemetrySource(snapshot.source)}
              </p>
              <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)" }}>
                Inventory feed: {policy.pluginInsights.inventoryConnected ? "connected" : "not connected"}
              </p>
              <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)" }}>
                Freshness: {freshness.label}
              </p>
              <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)" }}>
                Collector mode: {collectorConfigured ? "configured" : "not configured"}
              </p>
              <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)" }}>
                Diagnostic: {collectorDiagnostic}
              </p>
            </div>
          </details>
        ) : null}
      </article>

      <article className="card">
        <h3 className="card-title">Next Step</h3>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Plugin inventory and version update insights will appear here as setup completes.
        </p>
        <p style={{ margin: "0.8rem 0 0", fontSize: "0.88rem" }}>
          <Link href={`/apps/${siteId}/integrations`} className="action-link">Open integrations overview</Link>
        </p>
      </article>

      <article className="card">
        <h3 className="card-title">Plugin Insights</h3>
        <p className="card-muted" style={{ marginTop: 0 }}>
          {policy.pluginInsights.inventoryConnected
            ? "Live plugin inventory is connected."
            : "Live plugin inventory is not connected yet. You should not expect active/inactive, version, update, or security counts yet."}
        </p>
        <p style={{ margin: "0 0 0.55rem", fontSize: "0.82rem", color: "var(--muted)" }}>
          Data freshness: {freshness.label}
          {freshness.isStale ? " (stale)" : ""}
        </p>
        <div style={{ display: "grid", gap: "0.45rem" }}>
          <p style={{ margin: 0 }}>Active plugins: {renderMetric(policy.pluginInsights.activePlugins)}</p>
          <p style={{ margin: 0 }}>Inactive plugins: {renderMetric(policy.pluginInsights.inactivePlugins)}</p>
          <p style={{ margin: 0 }}>Updates available: {renderMetric(policy.pluginInsights.updatesAvailable)}</p>
          <p style={{ margin: 0 }}>Security issues: {renderMetric(policy.pluginInsights.securityIssues)}</p>
        </div>
        {freshness.isStale ? (
          <p style={{ margin: "0.55rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
            Monitoring data is older than expected. Refresh this page after collector sync completes.
          </p>
        ) : null}
      </article>
    </div>
  );
}