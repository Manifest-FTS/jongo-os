import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { listSiteDirectory } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { ArrowRightIcon } from "@/components/JongoIcons";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";

export default async function SitesPage() {
  const session = await auth();
  const overview = await getCoolifyOverview();
  const siteDirectory = await listSiteDirectory(session?.user?.id);

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Sites</p>
        <h1 style={{ margin: 0 }}>Site Directory</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          View all client sites in one place.
        </p>
      </div>

      <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>
        {siteDirectory.length} site{siteDirectory.length === 1 ? "" : "s"} across all clients
        {" - "}managed in Jongo
      </p>

      <details style={{ marginBottom: "1rem" }}>
        <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
          Developer Details
        </summary>
        <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
          Site source mode: {overview.mode}
        </p>
      </details>

      {siteDirectory.length === 0 ? (
        <div className="card">
          <p className="card-muted">No sites yet. Start by creating a client, then add their first site.</p>
          <p className="form-help" style={{ marginBottom: "0.75rem" }}>
            Open a client workspace to create and manage its sites.
          </p>
          <div style={{ marginBottom: "0.75rem" }}>
            <CreateOrganizationForm />
          </div>
          <p style={{ marginTop: "0.5rem" }}>
            <Link href="/organizations" className="action-link">Manage clients <ArrowRightIcon className="btn-icon" /></Link>
          </p>
        </div>
      ) : (
        <section className="grid">
          {siteDirectory.map((site) => {
            const overviewSite = overview.sites.find((item) => item.id === site.coolifyServiceUuid || item.id === site.id);

            return (
              <article key={site.id} className="card">
                <h2 className="card-title">{site.name}</h2>
                {site.description && (
                  <p className="card-muted" style={{ marginBottom: "0.35rem" }}>{site.description}</p>
                )}
                <p style={{ color: "var(--muted)", margin: "0 0 0.45rem", fontSize: "0.9rem" }}>
                  Client: {site.clientName}
                </p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.65rem" }}>
                  <span className={`status-chip ${overviewSite?.status ?? site.status}`}>
                    {overviewSite?.status ?? site.status}
                  </span>
                  <span className="tag">{site.source}</span>
                </div>
                {site.clientId !== "unassigned" ? (
                  <p style={{ margin: "0 0 0.45rem", fontSize: "0.9rem" }}>
                    <Link href={`/organizations/${site.clientId}`} className="action-link">
                      View client <ArrowRightIcon className="btn-icon" />
                    </Link>
                  </p>
                ) : null}
                <Link href={`/sites/${site.id}`} className="action-link">
                  Open workspace <ArrowRightIcon className="btn-icon" />
                </Link>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
