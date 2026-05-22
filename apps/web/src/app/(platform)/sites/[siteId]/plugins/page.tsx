import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";

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
  const hasInventory = policy.pluginInventory.length > 0;

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Installed Plugins</h2>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          {hasInventory
            ? "Live plugin inventory from the telemetry collector."
            : "Installed plugin rows appear here when the collector returns inventory for this app."}
        </p>
      </article>

      <article className="card">
        {policy.pluginInventory.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>Plugin</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>Active/Inactive</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>Version</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>Updates</th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>Security Issues</th>
                </tr>
              </thead>
              <tbody>
                {policy.pluginInventory.map((plugin) => (
                  <tr key={`${plugin.name}-${plugin.version ?? "n/a"}`}>
                    <td style={{ borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>{plugin.name}</td>
                    <td style={{ borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>{plugin.status}</td>
                    <td style={{ borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>{plugin.version ?? "-"}</td>
                    <td style={{ borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>{plugin.updateStatus}</td>
                    <td style={{ borderBottom: "1px solid var(--border)", padding: "0.5rem" }}>{plugin.securityIssues ?? "No vulnerability feed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--muted)" }}>No plugin rows are available yet for this site.</p>
        )}
      </article>
    </div>
  );
}