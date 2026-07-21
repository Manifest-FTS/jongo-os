import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteActivityFeed, getSiteWorkspace, isClientAdmin, listSiteDeployments } from "@/lib/repositories";
import PendingBadge from "@/components/PendingBadge";
import WordPressTelemetryConnectionPanel from "@/components/WordPressTelemetryConnectionPanel";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";
import {
  getWordPressTelemetryFreshness
} from "@/lib/wordpress-telemetry";
import { auth } from "@/lib/auth.config";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

export default async function IntegrationsPage({ params }: Params) {
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
    session?.user?.id && workspace.organizationId && await isClientAdmin(workspace.organizationId, session.user.id)
  );

  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer
  });

  const [overview, deployments, activity] = await Promise.all([
    canViewInternalMetadata ? getCoolifyOverview() : Promise.resolve(null),
    listSiteDeployments(siteId, viewer),
    getSiteActivityFeed(siteId, 4, viewer)
  ]);

  const canManageTelemetry = permissionSnapshot.canManageTelemetry;

  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const coolifySite = overview?.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const isWordPress = workspace?.siteType === "wordpress" || workspace?.resourceType === "WordPress";
  const deploymentSource = deployments[0]?.source ?? overview?.mode ?? "unknown";
  const resolvedSiteId = workspace?.slug ?? workspace?.id ?? siteId;
  const wpTelemetrySnapshot = await getWordPressTelemetrySnapshotForRequest({
    siteId: resolvedSiteId,
    isWordPress,
    hasCoolifyServiceUuid: Boolean(workspace?.coolifyServiceUuid)
  });
  const wpTelemetry = wpTelemetrySnapshot.policy;
  const freshness = getWordPressTelemetryFreshness(wpTelemetrySnapshot.checkedAt);
  const siteUrl = wpTelemetry.siteUrl?.trim() || "";
  const siteUrlLabel = siteUrl ? siteUrl.replace(/^https?:\/\//, "") : null;

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Integrations</h2>
        <p className="card-muted">Provider plugins, WordPress signals, and integration status.</p>
        {siteUrlLabel ? (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.86rem", color: "var(--muted)" }}>
            Site URL:{" "}
            <a href={siteUrl} target="_blank" rel="noreferrer" className="action-link">
              {siteUrlLabel}
            </a>
          </p>
        ) : null}
      </article>

      {canViewInternalMetadata && (
        <article className="card">
          <h3 className="card-title">Hosting Connection</h3>
          <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.55rem" }}>
            <p style={{ margin: 0 }}>
              Deployment provider: <span className="tag">{deploymentSource}</span>
            </p>
            <p style={{ margin: 0 }}>
              Hosting connection: <span className="tag">{workspace?.coolifyServiceUuid || coolifySite?.id ? "connected" : "not linked"}</span>
            </p>
            <p style={{ margin: 0 }}>
              Project: <span className="tag">{workspace?.coolifyProjectName ?? workspace?.coolifyProjectId ?? coolifySite?.coolifyProjectName ?? "not linked"}</span>
            </p>
            <p style={{ margin: 0 }}>
              Environment: <span className="tag">{workspace?.coolifyEnvironmentName ?? coolifySite?.coolifyEnvironmentName ?? "default"}</span>
            </p>
          </div>
        </article>
      )}

      {isWordPress ? (
        <article className="card">
          <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            WordPress Signals
            <span className={`status-chip ${wpTelemetry.tone}`}>{wpTelemetry.label}</span>
          </h3>
          <p className="card-muted" style={{ marginTop: 0 }}>{wpTelemetry.summary}</p>
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
          <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
            Data freshness: {freshness.label}
            {freshness.isStale ? " (stale)" : ""}
          </p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
            Last updated: {new Date(wpTelemetrySnapshot.checkedAt).toLocaleString()}
          </p>
          {canViewInternalMetadata ? (
            <p style={{ margin: "0.55rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
              Need maintenance details? Open app settings for mapping and provider checks.
            </p>
          ) : null}
          <p style={{ margin: "0.65rem 0 0", fontSize: "0.88rem" }}>
            <Link href={`/apps/${siteId}/plugins`} className="action-link">Open plugins page</Link>
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

      {isWordPress ? (
        <article className="card">
          <h3 className="card-title">WordPress Access</h3>
          <p className="card-muted" style={{ marginTop: 0 }}>
            Add this app's WordPress login details to show plugin monitoring here. Each app keeps its own saved details.
          </p>
          <WordPressTelemetryConnectionPanel siteId={siteId} canManage={canManageTelemetry} />
        </article>
      ) : null}

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
