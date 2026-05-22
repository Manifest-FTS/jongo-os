import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteActivityFeed, getSiteWorkspace, isClientAdmin, listSiteDeployments } from "@/lib/repositories";
import PendingBadge from "@/components/PendingBadge";
import WordPressTelemetryConnectionPanel from "@/components/WordPressTelemetryConnectionPanel";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";
import {
  formatWordPressCollectorStatus,
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

function buildIdentityMatchers(values: string[]) {
  return values.flatMap((value): Array<Record<string, string>> =>
    isUuid(value)
      ? [
          { id: value },
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value }
        ]
      : [
          { slug: value },
          { coolifyServiceUuid: value },
          { coolifyServiceId: value },
          { coolifyProjectId: value },
          { name: value }
        ]
  );
}

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasBootstrapGlobalAccess(email?: string | null): boolean {
  const configured = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const viewer = normalizeEmail(email);
  return Boolean(configured && viewer && configured === viewer);
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
    const bootstrapGlobalAccess = hasBootstrapGlobalAccess(session.user.email);
    const db = await getDb();
    if (db) {
      const identifiers = [
        siteId,
        workspace.id,
        workspace.slug,
        workspace.coolifyServiceUuid,
        workspace.coolifyProjectId,
        workspace.name
      ]
        .map((value) => value?.trim() || "")
        .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);

      const site = await db.site.findFirst({
        where: {
          AND: [
            {
              deletedAt: null,
              OR: buildIdentityMatchers(identifiers) as any
            },
            ...(workspace.organizationId ? [{ organizationId: workspace.organizationId }] : []),
            ...(bootstrapGlobalAccess
              ? []
              : [
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
                ])
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
      canManageTelemetry = Boolean(
        bootstrapGlobalAccess || canViewInternalMetadata || ownerAdmin || orgCollaboratorAdmin || siteAdmin
      );
    } else {
      canManageTelemetry = bootstrapGlobalAccess || canViewInternalMetadata;
    }
  }

  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const coolifySite = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const isWordPress = workspace?.siteType === "wordpress" || workspace?.resourceType === "WordPress";
  const deploymentSource = deployments[0]?.source ?? overview.mode;
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
            <p style={{ margin: "0.55rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
              Need maintenance details? Open app settings for mapping and provider checks.
            </p>
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
