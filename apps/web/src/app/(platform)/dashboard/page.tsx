import { getCoolifyOverview } from "@/lib/coolify";
import { getActivityFeed, listClientWorkspaces } from "@/lib/repositories";
import StatusPoll from "@/components/StatusPoll";
import { auth } from "@/lib/auth.config";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/JongoIcons";

export default async function DashboardPage() {
  const session = await auth();
  const overview = await getCoolifyOverview();
  const clients = await listClientWorkspaces(session?.user?.id);
  const activityFeed = await getActivityFeed();

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Dashboard</p>
        <h1 style={{ margin: 0 }}>Jongo Dashboard</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Client operations, site health, and publishing activity.
        </p>
      </div>

      <section className="grid">
        {/* Platform Stats */}
        <article className="card">
          <h2 className="card-title">Overview</h2>
          <div style={{ marginTop: "0.75rem" }}>
            <p style={{ margin: "0.35rem 0" }}>
              Total Clients: <strong>{clients.length}</strong>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              Total Sites: <strong>{overview.sites.length}</strong>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              Total Deployments: <strong>{overview.deployments.length}</strong>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              Data Mode: <span className="tag" style={{ display: "inline" }}>{overview.mode}</span>
            </p>
          </div>

          <details style={{ marginTop: "0.75rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
              Developer Details
            </summary>
            <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
              Runtime integration source is resolved server-side.
            </p>
          </details>
        </article>

        {/* Site Health - live poll every 30s */}
        <article className="card">
          <h2 className="card-title">Site Health</h2>
          <div style={{ marginTop: "0.75rem" }}>
            <StatusPoll intervalMs={30_000} />
          </div>
        </article>

        {/* Sites Needing Attention */}
        <article className="card">
          <h2 className="card-title">Needs Attention</h2>
          {overview.sites.filter((s) => s.status !== "healthy").length === 0 ? (
            <p className="card-muted">All sites are healthy</p>
          ) : (
            <div style={{ marginTop: "0.75rem" }}>
              {overview.sites
                .filter((s) => s.status !== "healthy")
                .map((site) => (
                  <p key={site.id} style={{ margin: "0.35rem 0" }}>
                    <strong>{site.name}</strong>{" "}
                    <span className={`status-chip ${site.status}`}>{site.status}</span>
                  </p>
                ))}
            </div>
          )}
        </article>

        {/* Quick Navigation */}
        <article className="card">
          <h2 className="card-title">Quick Actions</h2>
          <div style={{ marginTop: "0.75rem" }}>
            <p style={{ margin: "0.35rem 0" }}>
              <Link href="/sites" className="action-link">
                View all sites <ArrowRightIcon className="btn-icon" />
              </Link>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              <Link href="/organizations" className="action-link">
                Manage clients <ArrowRightIcon className="btn-icon" />
              </Link>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              <Link href="/settings" className="action-link">
                Open settings <ArrowRightIcon className="btn-icon" />
              </Link>
            </p>
          </div>
        </article>
      </section>

      {/* Recent Activity */}
      <section className="card" style={{ marginTop: "1rem" }}>
        <h2 className="card-title">Recent Activity</h2>
        {activityFeed.length === 0 ? (
          <p className="card-muted">No recent deployments</p>
        ) : (
          <div style={{ marginTop: "1rem" }}>
            {activityFeed.map((item) => (
              <div
                key={item.id}
                style={{
                  padding: "0.75rem",
                  marginBottom: "0.5rem",
                  background: "var(--bg-alt)",
                  borderRadius: "var(--radius)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <div>
                  <p style={{ margin: 0, fontWeight: 500 }}>
                    {item.title}
                  </p>
                  <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                    {item.detail}
                    {item.durationSeconds !== undefined && ` - ${item.durationSeconds < 60 ? `${item.durationSeconds}s` : `${Math.floor(item.durationSeconds / 60)}m`}`}
                    {item.timestamp ? ` - ${new Date(item.timestamp).toLocaleString()}` : ""}
                  </p>
                </div>
                <div style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
                  {item.environment && item.environment !== "unknown" && (
                    <span className="status-chip unknown" style={{ fontSize: "0.72rem" }}>{item.environment}</span>
                  )}
                  <span className={`status-chip ${item.status}`}>{item.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
