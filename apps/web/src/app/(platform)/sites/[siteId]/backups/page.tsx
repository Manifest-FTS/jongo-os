type Params = { params: Promise<{ siteId: string }> };

export default async function BackupsPage({ params }: Params) {
  const { siteId } = await params;

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Backups</h2>
        <p className="card-muted">Schedule, retention, and restore workflows for this app.</p>
      </article>

      <article className="card">
        <h3 className="card-title">Backup Policy</h3>
        <p style={{ margin: "0.35rem 0" }}>No backup schedule configured yet.</p>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Backup controls are intentionally grouped here to keep Overview focused on operational status.
        </p>
      </article>
    </div>
  );
}
