import Link from "next/link";
import { getClientForSite } from "../../lib/clients";
import { getCoolifyOverview } from "../../lib/coolify";

export default async function SitesPage() {
  const overview = await getCoolifyOverview();

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Sites / Applications</p>
        <h1 style={{ margin: 0 }}>Site Directory</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Global application index across all clients.
        </p>
      </div>

      <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>
        {overview.sites.length} total applications across all clients
      </p>
      <section className="grid">
        {overview.sites.map((site) => {
          const client = getClientForSite(site.id);

          return (
            <article key={site.id} className="card">
              <h2 className="card-title">{site.name}</h2>
              <p style={{ color: "var(--muted)", margin: "0 0 0.25rem", fontSize: "0.9rem" }}>
                ID: {site.id}
              </p>
              <p style={{ color: "var(--muted)", margin: "0 0 0.45rem", fontSize: "0.9rem" }}>
                Client: {client?.name ?? "Unassigned"}
              </p>
              <div style={{ marginBottom: "0.65rem" }}>
                <span className={`status-chip ${site.status}`}>{site.status}</span>
              </div>
              {client ? (
                <p style={{ margin: "0 0 0.45rem", fontSize: "0.9rem" }}>
                  <Link
                    href={`/organizations/${client.id}`}
                    style={{ color: "var(--accent)", textDecoration: "none" }}
                  >
                    View client →
                  </Link>
                </p>
              ) : null}
              <Link href={`/sites/${site.id}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                Open workspace →
              </Link>
            </article>
          );
        })}
      </section>
    </div>
  );
}
