import Link from "next/link";
import { notFound } from "next/navigation";
import { getClientById } from "../../../lib/clients";
import { getCoolifyOverview } from "../../../lib/coolify";

type Params = { params: Promise<{ organizationId: string }> };

export default async function OrganizationDetailPage({ params }: Params) {
  const { organizationId } = await params;
  const client = getClientById(organizationId);

  if (!client) {
    notFound();
  }

  const overview = await getCoolifyOverview();
  const clientSites = overview.sites.filter((site) => client.siteIds.includes(site.id));
  const clientSiteNames = new Set(clientSites.map((site) => site.name));
  const clientDeployments = overview.deployments.filter((deployment) => clientSiteNames.has(deployment.siteName));

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Dashboard / Clients / {client.name}</p>
        <h1 style={{ margin: 0 }}>{client.name}</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>{client.summary}</p>
      </div>

      <p className="card-muted" style={{ marginBottom: "0.5rem" }}>
        Dashboard / Clients / {client.name}
      </p>

      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Sites / Applications</h3>
          {clientSites.length === 0 ? (
            <p className="card-muted">No sites linked to this client yet.</p>
          ) : (
            <div>
              {clientSites.map((site) => (
                <p key={site.id} style={{ margin: "0.5rem 0" }}>
                  <Link href={`/sites/${site.id}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                    {site.name} →
                  </Link>{" "}
                  <span className={`status-chip ${site.status}`}>{site.status}</span>
                </p>
              ))}
            </div>
          )}
        </article>

        <article className="card">
          <h3 className="card-title">Recent Activity</h3>
          <p className="card-muted" style={{ marginBottom: "0.6rem" }}>
            {clientDeployments.length} deployment event{clientDeployments.length === 1 ? "" : "s"}
          </p>
          {client.recentActivity.map((item) => (
            <p key={item} style={{ margin: "0.45rem 0", fontSize: "0.9rem" }}>
              • {item}
            </p>
          ))}
        </article>

        <article className="card">
          <h3 className="card-title">Members</h3>
          <p className="card-muted">Client-scoped collaborator summary</p>
          {client.members.map((member) => (
            <p key={member.name} style={{ margin: "0.45rem 0", fontSize: "0.9rem" }}>
              {member.name} — {member.role}
            </p>
          ))}
        </article>
      </section>
    </div>
  );
}
