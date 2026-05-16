import Link from "next/link";
import { listSiteDeployments } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function BackupsPage({ params }: Params) {
  const { siteId } = await params;
  const deployments = await listSiteDeployments(siteId);
  const successfulDeployments = deployments.filter((item) => item.status === "success" || item.status === "healthy");
  const recentRestorePoints = successfulDeployments.slice(0, 5);

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Backups</h2>
        <p className="card-muted">Schedule, retention, and restore workflows for this app.</p>
      </article>

      <article className="card">
        <h3 className="card-title">Backup Policy</h3>
        <p style={{ margin: "0.35rem 0" }}>
          Backup checkpoints available: <strong>{recentRestorePoints.length}</strong>
        </p>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Restore points are inferred from successful deployments until a dedicated backup provider is connected.
        </p>
      </article>

      <article className="card">
        <h3 className="card-title">Recent Restore Points</h3>
        {recentRestorePoints.length === 0 ? (
          <p className="card-muted" style={{ marginBottom: 0 }}>No successful deployments found yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.55rem" }}>
            {recentRestorePoints.map((deployment) => (
              <div key={deployment.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.65rem" }}>
                <p style={{ margin: 0, fontSize: "0.88rem" }}>
                  {deployment.environment} - {formatRelativeTime(deployment.triggeredAt)}
                </p>
                <span className="status-chip healthy">ready</span>
              </div>
            ))}
          </div>
        )}
        <p style={{ margin: "0.8rem 0 0", fontSize: "0.88rem" }}>
          <Link href={`/apps/${siteId}/deployments`} className="action-link">Open deployment history</Link>
        </p>
      </article>
    </div>
  );
}
