import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteActivityFeed, getSiteWorkspace, isClientAdmin, listSiteDeployments } from "@/lib/repositories";
import PendingBadge from "@/components/PendingBadge";
import WordPressTelemetryConnectionPanel from "@/components/WordPressTelemetryConnectionPanel";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";
import {
  formatWordPressCollectorStatus,
  formatWordPressTelemetrySource,
  formatWordPressTelemetryValue,
  getWordPressTelemetryFreshness
} from "@/lib/wordpress-telemetry";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isAdminRole } from "@/lib/roles";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildSiteIdentityWhere(siteId: string) {
  if (isUuid(siteId)) {
    return {
      OR: [{ id: siteId }, { slug: siteId }, { coolifyServiceUuid: siteId }, { coolifyServiceId: siteId }],
      deletedAt: null
    };
  }

  return {
    OR: [{ slug: siteId }, { coolifyServiceUuid: siteId }, { coolifyServiceId: siteId }],
    deletedAt: null
  };
}

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
  let canManageTelemetry = false;
  const canViewInternalMetadata = Boolean(
    session?.user?.id &&
    workspace.organizationId &&
    await isClientAdmin(workspace.organizationId, session.user.id)
  );
  if (session?.user?.id) {
    const db = await getDb();
    if (db) {
      const site = await db.site.findFirst({
        where: {
          AND: [
            buildSiteIdentityWhere(siteId),
            {
              OR: [
                {
                  organization: {
                    deletedAt: null,
                    OR: [
                      { ownerId: session.user.id },
                      { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
                    ]
                  }
                },
                { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
              ]
            }
          ]
        },
        include: {
          organization: {
            select: {
              ownerId: true,
              collaborators: {
                where: { userId: session.user.id, deletedAt: null },
                select: { role: true }
              }
            }
          },
          collaborators: {
            where: { userId: session.user.id, deletedAt: null },
            select: { role: true }
          }
        }
      });

      const ownerAdmin = site?.organization?.ownerId === session.user.id;
      const orgCollaboratorAdmin = isAdminRole(site?.organization?.collaborators?.[0]?.role);
      const siteAdmin = isAdminRole(site?.collaborators?.[0]?.role);
      canManageTelemetry = Boolean(canViewInternalMetadata || ownerAdmin || orgCollaboratorAdmin || siteAdmin);
    }
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
  const freshness = getWordPressTelemetryFreshness(wpTelemetrySnapshot.checkedAt);
  const collectorConfigured = Boolean(process.env.WORDPRESS_TELEMETRY_COLLECTOR_URL?.trim());
  const collectorDiagnostic = !collectorConfigured
    ? "Collector endpoint is not configured."
    : wpTelemetrySnapshot.source === "collector"
      ? "Collector response is active."
      : "Collector is configured, but this snapshot is currently using fallback policy data.";
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

      {isWordPress ? (
        <article className="card">
          <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            WordPress Signals
            <span className={`status-chip ${wpTelemetry.tone}`}>{wpTelemetry.label}</span>
          </h3>
          <p className="card-muted" style={{ marginTop: 0 }}>{wpTelemetry.summary}</p>
          <div style={{ display: "grid", gap: "0.55rem" }}>
            <p style={{ margin: 0 }}>Core version: {formatWordPressTelemetryValue(wpTelemetry.signals.coreVersion)}</p>
            <p style={{ margin: 0 }}>Plugin status: {formatWordPressTelemetryValue(wpTelemetry.signals.pluginStatus)}</p>
            <p style={{ margin: 0 }}>Theme status: {formatWordPressTelemetryValue(wpTelemetry.signals.themeStatus)}</p>
            <p style={{ margin: 0 }}>Update availability: {formatWordPressTelemetryValue(wpTelemetry.signals.updateAvailability)}</p>
            <p style={{ margin: 0 }}>Maintenance mode: {formatWordPressTelemetryValue(wpTelemetry.signals.maintenanceMode)}</p>
            <p style={{ margin: 0 }}>Site health: {formatWordPressTelemetryValue(wpTelemetry.signals.siteHealth)}</p>
            <p style={{ margin: 0 }}>
              Monitoring status: <span className="tag">{formatWordPressCollectorStatus(wpTelemetry.collectorStatus)}</span>
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
          <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
            Data freshness: {freshness.label}
            {freshness.isStale ? " (stale)" : ""}
          </p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
            Last updated: {new Date(wpTelemetrySnapshot.checkedAt).toLocaleString()}
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
                  Data source: {formatWordPressTelemetrySource(wpTelemetrySnapshot.source)}
                </p>
                <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--muted)" }}>
                  Inventory feed: {wpTelemetry.pluginInsights.inventoryConnected ? "connected" : "not connected"}
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
          <p style={{ margin: "0.65rem 0 0", fontSize: "0.88rem" }}>
            <Link href={`/apps/${siteId}/plugins`} className="action-link">Open plugin stats tab</Link>
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

      {isWordPress && canManageTelemetry ? (
        <article className="card">
          <h3 className="card-title">Connect Telemetry</h3>
          <p className="card-muted" style={{ marginTop: 0 }}>
            Save per-app WordPress REST credentials to collect live plugin telemetry.
          </p>
          <WordPressTelemetryConnectionPanel siteId={siteId} />
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
