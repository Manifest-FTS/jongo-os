import PendingBadge from "@/components/PendingBadge";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

type Params = { params: Promise<{ siteId: string }> };

export default async function AnalyticsPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const [overview, workspace, deployments] = await Promise.all([
    getCoolifyOverview(),
    getSiteWorkspace(siteId, viewer),
    listSiteDeployments(siteId, viewer)
  ]);

  if (!workspace) {
    notFound();
  }

  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);

  const productionDeployments = deployments.filter((d) => d.environment === "production");
  const stagingDeployments = deployments.filter((d) => d.environment === "staging");

  return (
    <div className="page-stack">
      {/* Deployment count summary — factual, not misleading */}
      <section className="metric-strip">
        <article className="card metric-card">
          <p className="metric-value">{deployments.length}</p>
          <p className="metric-label">Total Deploys</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{productionDeployments.length}</p>
          <p className="metric-label">Production Deploys</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{stagingDeployments.length}</p>
          <p className="metric-label">Staging Deploys</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">
            <span className={`status-chip ${site?.status ?? "unknown"}`} style={{ fontSize: "0.85rem" }}>
              {site?.status ?? "unknown"}
            </span>
          </p>
          <p className="metric-label">App Status</p>
        </article>
      </section>

      {/* Analytics pending notice */}
      <article className="card">
        <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
          Analytics <PendingBadge reason="Web analytics (pageviews, sessions, visitors) are not yet connected. This section will integrate with an analytics provider in a future update." />
        </h3>
        <p className="card-muted" style={{ marginTop: "0.5rem" }}>
          Visitor traffic, pageview trends, and conversion data will appear here once an analytics provider is connected.
        </p>
        <p style={{ margin: "0.75rem 0 0", fontSize: "0.88rem", color: "var(--muted)" }}>
          Deployment counts above reflect deploy history, not web traffic. For full deployment history, see the{" "}
          <a href={`/apps/${siteId}/deployments`} className="action-link">Deployments</a> tab.
        </p>
      </article>
    </div>
  );
}
