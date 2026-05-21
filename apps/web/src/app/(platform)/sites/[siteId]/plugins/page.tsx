import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { getWordPressTelemetrySnapshotForRequest } from "@/lib/wordpress-telemetry-snapshot";

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

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Plugin Stats</h2>
        <p className="card-muted">Read-only WordPress plugin telemetry snapshot for this app.</p>
      </article>

      <div className="grid">
        <article className="card">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>Plugin status</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "1.05rem", fontWeight: 600 }}>{policy.signals.pluginStatus}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>Update availability</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "1.05rem", fontWeight: 600 }}>{policy.signals.updateAvailability}</p>
        </article>
        <article className="card">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>Collector status</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "1.05rem", fontWeight: 600 }}>{policy.collectorStatus.replace(/_/g, " ")}</p>
        </article>
      </div>

      <article className="card">
        <h3 className="card-title">Telemetry Source</h3>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Snapshot source: <code>{snapshot.source}</code> - checked {new Date(snapshot.checkedAt).toLocaleString()}
        </p>
      </article>

      <article className="card">
        <h3 className="card-title">Next Step</h3>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Plugin inventory counts and version drift metrics will populate here once WordPress collector pull integration is enabled.
        </p>
        <p style={{ margin: "0.8rem 0 0", fontSize: "0.88rem" }}>
          <Link href={`/apps/${siteId}/integrations`} className="action-link">Open integrations telemetry</Link>
        </p>
      </article>
    </div>
  );
}