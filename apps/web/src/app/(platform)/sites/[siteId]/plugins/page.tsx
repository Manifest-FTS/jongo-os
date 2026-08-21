import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import WordPressTelemetryConnectionPanel from "@/components/WordPressTelemetryConnectionPanel";
import RefreshPluginInventoryButton from "@/components/RefreshPluginInventoryButton";
import { getWordPressTelemetrySnapshot } from "@/lib/wordpress-telemetry";
import { getWordPressTelemetrySnapshotFromCollector } from "@/lib/wordpress-telemetry-collector";
import { readCachedPluginInventory } from "@/lib/wordpress-plugin-inventory";
import { describeUpdateDataFreshness } from "@/lib/wordpress-plugin-probe";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

function formatAgo(value: Date): string {
  const mins = Math.floor((Date.now() - value.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function normalizeWordPressAdminUrl(siteUrl: string): string | null {
  const trimmed = siteUrl.trim();
  if (!trimmed) {
    return null;
  }

  return `${trimmed.replace(/\/+$/, "")}/wp-admin/plugins.php`;
}

function StatusBadge({
  tone,
  label,
  icon
}: {
  tone: "neutral" | "warning" | "danger";
  label: string;
  icon: "warning" | "shield";
}) {
  const colors =
    tone === "warning"
      ? {
          background: "rgba(214, 146, 44, 0.14)",
          border: "rgba(214, 146, 44, 0.28)",
          text: "#b86a00",
          icon: "#b86a00"
        }
      : tone === "danger"
        ? {
            background: "rgba(198, 53, 53, 0.14)",
            border: "rgba(198, 53, 53, 0.28)",
            text: "#b71c1c",
            icon: "#b71c1c"
          }
        : {
            background: "rgba(127, 127, 127, 0.12)",
            border: "rgba(127, 127, 127, 0.22)",
            text: "inherit",
            icon: "#666"
          };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.2rem 0.55rem",
        borderRadius: 999,
        background: colors.background,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        lineHeight: 1.2,
        fontWeight: 600,
        whiteSpace: "nowrap"
      }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", width: 12, height: 12, color: colors.icon }}>
        {icon === "warning" ? (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path d="M8 1.25 15.25 14.75H.75L8 1.25Zm0 3.08-4.52 8.42h9.04L8 4.33Zm-.75 2.92h1.5v3.65h-1.5V7.25Zm0 4.4h1.5v1.4h-1.5v-1.4Z" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path d="M8 1.25 3.1 3.1v3.74c0 3.1 1.97 5.93 4.9 7.91 2.93-1.98 4.9-4.81 4.9-7.91V3.1L8 1.25Zm0 2.03 3.4 1.29v2.13c0 2.14-1.2 4.18-3.4 5.74-2.2-1.56-3.4-3.6-3.4-5.74V4.57L8 3.28Zm-.74 2.54.96 1.12 1.98-2.08.82.78-2.8 2.95-1.8-2.1.84-.67Z" />
          </svg>
        )}
      </span>
      <span>{label}</span>
    </span>
  );
}

function formatUpdateBadge(updateStatus: string) {
  if (updateStatus === "Update available") {
    return <StatusBadge tone="warning" label={updateStatus} icon="warning" />;
  }

  return <span style={{ color: "inherit", fontWeight: 500 }}>{updateStatus}</span>;
}

function formatSecurityBadge(securityIssues: string | null) {
  if (securityIssues === "Vulnerability detected") {
    return <StatusBadge tone="danger" label={securityIssues} icon="shield" />;
  }

  if (securityIssues) {
    return <span style={{ color: "inherit", fontWeight: 500 }}>{securityIssues}</span>;
  }

  return <span style={{ color: "inherit", fontWeight: 500 }}>No vulnerability feed</span>;
}

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

  const isWordPress = workspace.siteType === "wordpress" || workspace.resourceType === "WordPress";
  if (!isWordPress) {
    notFound();
  }

  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer
  });
  const canManageTelemetry = permissionSnapshot.canManageTelemetry;

  const resolvedSiteId = workspace.slug ?? workspace.id ?? siteId;
  const fallbackSnapshot = getWordPressTelemetrySnapshot({
    siteId: resolvedSiteId,
    isWordPress,
    hasCoolifyServiceUuid: Boolean(workspace.coolifyServiceUuid)
  });
  const collectorSnapshot = await getWordPressTelemetrySnapshotFromCollector({
    fallback: fallbackSnapshot,
    workspace,
    requestedSiteId: siteId,
    preferredSiteDbId: workspace.id
  });
  const snapshot = collectorSnapshot ?? fallbackSnapshot;

  const policy = snapshot.policy;
  const pluginCount = policy.pluginInventory.length;
  const pluginCountLabel = String(pluginCount);
  const adminPluginsUrl = policy.siteUrl ? normalizeWordPressAdminUrl(policy.siteUrl) : null;
  const inventoryUnavailable = pluginCount === 0 && policy.signals.pluginStatus !== "healthy";

  // The container probe caches its result, so say how old the reading is rather
  // than presenting stale counts as current.
  const cachedInventory = await readCachedPluginInventory(workspace.id);
  const collectedLabel = cachedInventory ? `Inventory read ${formatAgo(cachedInventory.collectedAt)}.` : null;
  const updateFreshness = cachedInventory?.status === "ok"
    ? describeUpdateDataFreshness(
        cachedInventory.updateDataCheckedAt
          ? Math.floor(cachedInventory.updateDataCheckedAt.getTime() / 1000)
          : null
      )
    : null;

  return (
    <div className="page-stack">
      <article className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Installed Plugins ({pluginCountLabel})</h2>
          {adminPluginsUrl ? (
            <>
              <style>{`
                .wp-plugins-pill {
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  padding: 0.45rem 0.9rem;
                  border-radius: 999px;
                  border: 1px solid rgba(32, 123, 62, 0.32);
                  color: #1f7a3b;
                  background: transparent;
                  font-size: 0.9rem;
                  font-weight: 600;
                  line-height: 1;
                  text-decoration: none;
                  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
                }

                .wp-plugins-pill:hover {
                  background: #1f7a3b;
                  border-color: #1f7a3b;
                  color: #ffffff;
                }
              `}</style>
              <Link href={adminPluginsUrl} target="_blank" rel="noreferrer" className="wp-plugins-pill">
                View Plugins
              </Link>
            </>
          ) : null}
        </div>
        <div style={{ marginTop: "0.85rem" }}>
          <RefreshPluginInventoryButton siteId={siteId} collectedLabel={collectedLabel} />
        </div>
        {updateFreshness?.stale ? (
          // "Up to date" comes from WordPress's own update cache. If wp-cron has
          // stopped, every row reads as current — reassuring and wrong — so the
          // age of that cache is stated rather than trusted.
          <p
            style={{
              margin: "0.7rem 0 0",
              padding: "0.55rem 0.7rem",
              borderRadius: "8px",
              border: "1px solid rgba(214, 146, 44, 0.28)",
              background: "rgba(214, 146, 44, 0.1)",
              fontSize: "0.8rem",
              color: "#b86a00"
            }}
          >
            {updateFreshness.detail}
          </p>
        ) : null}

{policy.pluginInventory.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: "0.86rem" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.6rem 0.75rem" }}>Plugin</th>
                  <th style={{ textAlign: "left", padding: "0.6rem 0.75rem" }}>Active/Inactive</th>
                  <th style={{ textAlign: "left", padding: "0.6rem 0.75rem" }}>Version</th>
                  <th style={{ textAlign: "left", padding: "0.6rem 0.75rem" }}>Updates</th>
                  <th style={{ textAlign: "left", padding: "0.6rem 0.75rem" }}>Security Issues</th>
                </tr>
              </thead>
              <tbody>
                {policy.pluginInventory.map((plugin, index) => (
                  <tr
                    key={`${plugin.name}-${plugin.version ?? "n/a"}`}
                    style={{ backgroundColor: index % 2 === 0 ? "rgba(127, 127, 127, 0.06)" : "transparent" }}
                  >
                    <td style={{ padding: "0.75rem 0.75rem" }}>{plugin.name}</td>
                    <td style={{ padding: "0.75rem 0.75rem" }}>{plugin.status}</td>
                    <td style={{ padding: "0.75rem 0.75rem" }}>{plugin.version ?? "-"}</td>
                    <td style={{ padding: "0.75rem 0.75rem" }}>{formatUpdateBadge(plugin.updateStatus)}</td>
                    <td style={{ padding: "0.75rem 0.75rem" }}>{formatSecurityBadge(plugin.securityIssues)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : inventoryUnavailable ? (
          <div style={{ display: "grid", gap: "0.45rem" }}>
            <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--muted)" }}>
              Live plugin inventory is currently unavailable for this WordPress app.
            </p>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
              {policy.summary}
            </p>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--muted)" }}>No installed plugins were returned for this app.</p>
        )}
      </article>

      {/* <article className="card">
        
      </article> */}

      <article className="card hidden">
        <h3 className="card-title">WordPress Access</h3>
        <p className="card-muted" style={{ marginTop: 0 }}>
          Update WordPress telemetry credentials here when plugin inventory is unavailable or permissions change.
        </p>
        <WordPressTelemetryConnectionPanel siteId={siteId} canManage={canManageTelemetry} />
      </article>
    </div>
  );
}