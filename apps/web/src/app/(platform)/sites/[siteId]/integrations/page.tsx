import { getSiteWorkspace } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

export default async function IntegrationsPage({ params }: Params) {
  const { siteId } = await params;
  const workspace = await getSiteWorkspace(siteId);
  const isWordPress = workspace?.siteType === "wordpress";

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Integrations</h2>
        <p className="card-muted">Provider plugins, WordPress signals, and integration status.</p>
      </article>

      {isWordPress ? (
        <article className="card">
          <h3 className="card-title">WordPress Signals</h3>
          <div style={{ display: "grid", gap: "0.55rem" }}>
            <p style={{ margin: 0 }}>Plugin updates: not connected</p>
            <p style={{ margin: 0 }}>Core version: not connected</p>
            <p style={{ margin: 0 }}>Maintenance mode: not connected</p>
          </div>
        </article>
      ) : (
        <article className="card">
          <h3 className="card-title">No active integrations</h3>
          <p className="card-muted">Attach provider tooling here as this app stack grows.</p>
        </article>
      )}
    </div>
  );
}
