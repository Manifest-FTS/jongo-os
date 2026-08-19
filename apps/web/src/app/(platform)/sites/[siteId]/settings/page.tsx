type Params = { params: Promise<{ siteId: string }> };

import SiteInfoForm from "@/components/SiteInfoForm";
import SiteStagingToggle from "@/components/SiteStagingToggle";
import WordPressAdvancedControls from "@/components/WordPressAdvancedControls";
import SiteDangerZone from "@/components/SiteDangerZone";
import PageAutoRefresh from "@/components/PageAutoRefresh";
import Link from "next/link";
import { getSiteWorkspace } from "@/lib/repositories";
import { getCoolifyAppStagingCapability, getCoolifyOverview } from "@/lib/coolify";
import { auth } from "@/lib/auth.config";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function SiteSettingsPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const [workspace, overview] = await Promise.all([
    getSiteWorkspace(siteId, viewer),
    getCoolifyOverview()
  ]);

  if (!workspace) {
    return (
      <div>
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2 style={{ margin: 0 }}>Settings temporarily unavailable</h2>
          <p className="card-muted" style={{ marginTop: "0.35rem" }}>
            Jongo could not resolve this app record right now. Refresh in a moment and try again.
          </p>
          <p className="card-muted" style={{ marginTop: "0.35rem" }}>
            If this persists, run Settings sync and verify the app mapping in Coolify.
          </p>
        </div>
      </div>
    );
  }
  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer
  });
  const canViewInternalMetadata = permissionSnapshot.canViewInternalMetadata;
  const isWordPress = workspace.siteType === "wordpress" || workspace.resourceType === "WordPress";
  const stagingCapability = workspace?.coolifyServiceUuid
    ? await getCoolifyAppStagingCapability(workspace.coolifyServiceUuid, workspace.coolifyProjectId ?? undefined, /* Relaxed: must match the API route, or the UI hides staging the platform did provision. */ { relaxedTargetMatch: true })
    : null;
  const stagingEnvironmentReady = Boolean(stagingCapability?.detected);
  const stagingTargetAttached = Boolean(stagingCapability?.applicationUuid);
  const stagingConfigured = Boolean(workspace.stagingEnabled && stagingEnvironmentReady && stagingTargetAttached);
  const isStagingResource =
    workspace.coolifyEnvironmentName?.toLowerCase().includes("staging")
    || workspace.name.toLowerCase().includes("staging")
    || workspace.slug?.toLowerCase().includes("staging")
    || false;

  const latestWordPressVersion = workspace.id
    ? await (async () => {
        const { getDb } = await import("@/lib/db");
        const prisma = await getDb();
        if (!prisma || !("siteBackup" in prisma)) {
          return null;
        }

        try {
          const row = await (prisma as any).siteBackup.findFirst({
            where: {
              siteId: workspace.id,
              status: "success",
              wpVersion: { not: null }
            },
            orderBy: { startedAt: "desc" },
            select: { wpVersion: true }
          });

          return typeof row?.wpVersion === "string" ? row.wpVersion : null;
        } catch {
          return null;
        }
      })()
    : null;

  return (
    <div>
      <PageAutoRefresh intervalMs={12000} />

      {isWordPress ? (
        <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 1fr)", alignItems: "start" }}>
          <WordPressAdvancedControls
            siteId={siteId}
            canManageActions={Boolean(session?.user?.id)}
            initialStagingEnabled={Boolean(workspace.stagingEnabled)}
            hasDetectedStagingTarget={stagingTargetAttached}
          />

          <div style={{ display: "grid", gap: "1rem" }}>
            <article className="card">
              <h3 className="card-title">Service Telemetry</h3>
              <div style={{ display: "grid", gap: "0.45rem", fontSize: "0.88rem", marginTop: "0.55rem" }}>
                <p style={{ margin: 0 }}><strong>Service ID:</strong> {workspace.coolifyServiceUuid ?? "Unavailable"}</p>
                <p style={{ margin: 0 }}><strong>Project ID:</strong> {workspace.coolifyProjectId ?? "Unavailable"}</p>
              </div>
            </article>

            <article className="card">
              <h3 className="card-title">WordPress Version</h3>
              <p style={{ margin: "0.55rem 0 0" }}>{latestWordPressVersion ?? "Unavailable"}</p>
            </article>

            <article className="card">
              <h3 className="card-title">PHP Version</h3>
              <p style={{ margin: "0.55rem 0 0" }}>Unavailable</p>
            </article>

            <article className="card">
              <h3 className="card-title">Database</h3>
              <p className="card-muted" style={{ margin: "0.55rem 0 0.35rem" }}>Prefix: Unavailable</p>
              <button type="button" className="btn" disabled title="Database prefix editing will be available in a follow-up update.">
                Change Prefix
              </button>
            </article>
          </div>
        </div>
      ) : null}

      {/* Site Record (non-WordPress DB-backed sites) */}
      {!isWordPress && workspace?.source === "db" && (
        <article className="card" style={{ marginBottom: "1.5rem" }}>
          <h3 className="card-title">Site Information</h3>
          <p className="card-muted" style={{ marginBottom: "1rem" }}>Update name, description, and infrastructure links.</p>
          <SiteInfoForm
            siteId={siteId}
            initial={{
              name: workspace.name,
              description: workspace.description,
              coolifyServiceUuid: workspace.coolifyServiceUuid,
              coolifyProjectId: workspace.coolifyProjectId,
              gitRepositoryUrl: workspace.gitRepositoryUrl,
              temporaryDomainSlug: workspace.temporaryDomainSlug,
              temporaryDomainSuffix: workspace.temporaryDomainSuffix
            }}
          />
        </article>
      )}

      {canViewInternalMetadata && workspace?.ownershipState !== "mapped" && (
        <div className="diagnostic-banner" style={{ marginBottom: "1rem" }}>
          <strong>Ownership mapping needs attention.</strong> Map a Project ID in Site Information to avoid orphaned resources.
        </div>
      )}

      {/* Staging (non-WordPress view) */}
      {!isWordPress && !isStagingResource ? (
        <article className="card" style={{ marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
            <div>
              <h3 className="card-title" style={{ margin: 0 }}>Staging Environment</h3>
              <p className="card-muted" style={{ margin: "0.35rem 0 0" }}>
                Turn on staging for this site. Check the platform Staging tab and give it a few minutes to provision.
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginTop: "0.55rem", flexWrap: "wrap" }}>
                <span className={`status-chip ${stagingEnvironmentReady ? "healthy" : "unknown"}`}>
                  {stagingEnvironmentReady ? "Environment created" : "Environment missing"}
                </span>
                <span className={`status-chip ${stagingTargetAttached ? "healthy" : "degraded"}`}>
                  {stagingTargetAttached ? "Target attached" : "Target missing"}
                </span>
              </div>
            </div>
            <SiteStagingToggle
              siteId={siteId}
              initialEnabled={Boolean(workspace.stagingEnabled)}
              hasDetectedStagingTarget={stagingTargetAttached}
            />
          </div>
          {stagingConfigured ? (
            <p style={{ margin: "0.85rem 0 0", fontSize: "0.88rem" }}>
              <Link href={`/apps/${siteId}/staging`} className="action-link">Open Staging workspace</Link>
            </p>
          ) : null}
        </article>
      ) : null}

      {/* Developer Details (replaces standalone Advanced tab) */}
      {canViewInternalMetadata ? (
      <details style={{ marginBottom: "1.5rem" }}>
        <summary
          style={{
            cursor: "pointer",
            padding: "0.85rem 1rem",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            fontWeight: 600,
            fontSize: "0.9rem",
            userSelect: "none"
          }}
        >
          Maintenance Details
        </summary>
        <article className="card" style={{ marginTop: "0.5rem" }}>
          <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
            Operational reference for ownership mapping and provider linkage.
          </p>
          <div style={{ display: "grid", gap: "0.4rem", fontSize: "0.88rem" }}>
            <p style={{ margin: 0 }}>
              Provider data mode: <strong>{overview.mode}</strong>{" "}
              <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>· checked {formatAgo(overview.generatedAt)}</span>
            </p>
            <p style={{ margin: 0 }}>
              Ownership mapping: <strong>{workspace?.ownershipState === "mapped" ? "mapped" : "needs review"}</strong>
            </p>
            <p style={{ margin: 0 }}>
              App link to provider: <strong>{workspace?.coolifyServiceUuid ? "connected" : "missing"}</strong>
            </p>
            <p style={{ margin: 0 }}>
              Project mapping: <strong>{workspace?.coolifyProjectId ? "set" : "missing"}</strong>
            </p>
            {overview.fetchError ? (
              <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
                Provider connection needs attention. Verify runtime credentials in Platform Settings.
              </p>
            ) : null}
            <p style={{ margin: "0.35rem 0 0", fontSize: "0.88rem" }}>
              <Link href="/settings#runtime-diagnostics" className="action-link">Open platform diagnostics</Link>
            </p>
          </div>
        </article>
      </details>
      ) : null}

      {/* Last on the page on purpose: destructive controls should never sit
          next to routine settings someone is clicking through quickly. */}
      <SiteDangerZone
        siteId={siteId}
        siteSlug={workspace.slug ?? String(siteId)}
        siteName={workspace.name || workspace.slug || String(siteId)}
        canDelete={permissionSnapshot.role === "admin"}
        hasCoolifyResource={Boolean(workspace.coolifyServiceUuid?.trim())}
      />
    </div>
  );
}
