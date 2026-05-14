import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { listSiteDirectory } from "@/lib/repositories";

export default async function SitesPage() {
  const overview = await getCoolifyOverview();
  const siteDirectory = await listSiteDirectory();

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
        {siteDirectory.map((site) => {
          const overviewSite = overview.sites.find((item) => item.id === site.id);

          return (
            <article key={site.id} className="card">
              <h2 className="card-title">{site.name}</h2>
              <p style={{ color: "var(--muted)", margin: "0 0 0.25rem", fontSize: "0.9rem" }}>
                ID: {site.id}
              </p>
              <p style={{ color: "var(--muted)", margin: "0 0 0.45rem", fontSize: "0.9rem" }}>
                Client: {site.clientName}
              </p>
              <div style={{ marginBottom: "0.65rem" }}>
                <span className={`status-chip ${overviewSite?.status ?? site.status}`}>{overviewSite?.status ?? site.status}</span>
              </div>
              {site.clientId !== "unassigned" ? (
                <p style={{ margin: "0 0 0.45rem", fontSize: "0.9rem" }}>
                  <Link
                    href={`/organizations/${site.clientId}`}
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
