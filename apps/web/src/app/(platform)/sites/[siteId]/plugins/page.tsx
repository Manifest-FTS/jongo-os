import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";
import { formatWordPressCollectorStatus, formatWordPressTelemetryValue } from "@/lib/wordpress-telemetry";

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
        {canViewInternalMetadata ? (
          <details style={{ marginTop: "0.4rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.78rem", color: "var(--muted)" }}>
              Technical details
            </summary>
            <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "var(--muted)" }}>
              Data source: {snapshot.source}
            </p>
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
    </div>
  );
}