import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteActivityFeed, getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";
import PendingBadge from "@/components/PendingBadge";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

type Params = { params: Promise<{ siteId: string }> };

export default async function IntegrationsPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const [workspace, overview, deployments, activity] = await Promise.all([
    getSiteWorkspace(siteId, viewer),
    getCoolifyOverview(),
    listSiteDeployments(siteId, viewer),
    getSiteActivityFeed(siteId, 4, viewer)
  ]);

  if (!workspace) {
    notFound();
  }

  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const coolifySite = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const isWordPress = workspace?.siteType === "wordpress";
  const deploymentSource = deployments[0]?.source ?? overview.mode;
  const resolvedSiteId = workspace?.slug ?? workspace?.id ?? siteId;
  const wpTelemetrySnapshot = await getWordPressTelemetrySnapshotForRequest({
    siteId: resolvedSiteId,
    isWordPress,
    hasCoolifyServiceUuid: Boolean(workspace?.coolifyServiceUuid)
  });
  const wpTelemetry = wpTelemetrySnapshot.policy;

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Integrations</h2>
        <p className="card-muted">Provider plugins, WordPress signals, and integration status.</p>
      </article>

      <article className="card">
        <h3 className="card-title">Provider Connectivity</h3>
        <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.55rem" }}>
          <p style={{ margin: 0 }}>
            Deployment source: <span className="tag">{deploymentSource}</span>
          </p>
          <p style={{ margin: 0 }}>
            Coolify service: <span className="tag">{workspace?.coolifyServiceUuid ?? coolifySite?.id ?? "not linked"}</span>
          </p>
          <p style={{ margin: 0 }}>
            Coolify project: <span className="tag">{workspace?.coolifyProjectName ?? workspace?.coolifyProjectId ?? coolifySite?.coolifyProjectName ?? "not linked"}</span>
          </p>
          <p style={{ margin: 0 }}>
            Environment: <span className="tag">{workspace?.coolifyEnvironmentName ?? coolifySite?.coolifyEnvironmentName ?? "default"}</span>
          </p>
        </div>
      </article>

      {isWordPress ? (
        <article className="card">
          <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            WordPress Signals
            <span className={`status-chip ${wpTelemetry.tone}`}>{wpTelemetry.label}</span>
          </h3>
          <p className="card-muted" style={{ marginTop: 0 }}>{wpTelemetry.summary}</p>
          <div style={{ display: "grid", gap: "0.55rem" }}>
            <p style={{ margin: 0 }}>Core version: {wpTelemetry.signals.coreVersion}</p>
            <p style={{ margin: 0 }}>Plugin status: {wpTelemetry.signals.pluginStatus}</p>
            <p style={{ margin: 0 }}>Theme status: {wpTelemetry.signals.themeStatus}</p>
            <p style={{ margin: 0 }}>Update availability: {wpTelemetry.signals.updateAvailability}</p>
            <p style={{ margin: 0 }}>Maintenance mode: {wpTelemetry.signals.maintenanceMode}</p>
            <p style={{ margin: 0 }}>Site health: {wpTelemetry.signals.siteHealth}</p>
            <p style={{ margin: 0 }}>
              Collector status: <span className="tag">{wpTelemetry.collectorStatus.replace(/_/g, " ")}</span>
            </p>
          </div>
          {wpTelemetry.needsSetup && wpTelemetry.setupSteps.length > 0 ? (
            <div style={{ marginTop: "0.65rem" }}>
              <p style={{ margin: "0 0 0.4rem", fontSize: "0.82rem", fontWeight: 600 }}>Guided setup</p>
              <ol style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: "0.25rem" }}>
                {wpTelemetry.setupSteps.map((step) => (
                  <li key={step} style={{ fontSize: "0.82rem", color: "var(--muted)" }}>{step}</li>
                ))}
              </ol>
            </div>
          ) : null}
          <p style={{ margin: "0.7rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
            {wpTelemetry.guidance}
          </p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
            Snapshot source: <code>{wpTelemetrySnapshot.source}</code> - checked {new Date(wpTelemetrySnapshot.checkedAt).toLocaleString()}
          </p>
        </article>
      ) : (
        <article className="card">
          <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            No active integrations
            <PendingBadge reason="Provider integrations (analytics, monitoring, CMS signals) will connect here as they become available." />
          </h3>
          <p className="card-muted">Attach provider tooling here as this app stack grows.</p>
        </article>
      )}

      <article className="card">
        <h3 className="card-title">Recent Integration Events</h3>
        {activity.length === 0 ? (
          <p className="card-muted" style={{ marginBottom: 0 }}>No deployment events available yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.6rem" }}>
            {activity.map((item) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.65rem" }}>
                <p style={{ margin: 0, fontSize: "0.88rem" }}>{item.detail}</p>
                <span className={`status-chip ${item.status}`}>{item.status}</span>
              </div>
            ))}
          </div>
        )}
        <p style={{ margin: "0.8rem 0 0", fontSize: "0.88rem" }}>
          <Link href={`/apps/${siteId}/settings`} className="action-link">Open app settings</Link>
        </p>
      </article>
    </div>
  );
}
