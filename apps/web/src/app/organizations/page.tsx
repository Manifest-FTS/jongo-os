import Link from "next/link";
import { getClients } from "../../lib/clients";

export default function OrganizationsPage() {
  const clients = getClients();

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Clients</p>
        <h1 style={{ margin: 0 }}>Client Directory</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Manage client accounts, teams, and operational ownership.
        </p>
      </div>

      <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>
        Manage client accounts, teams, and operational ownership.
      </p>
      <section className="grid">
        {clients.map((client) => (
          <article key={client.id} className="card">
            <h3 className="card-title">{client.name}</h3>
            <p className="card-muted">{client.summary}</p>
            <p style={{ margin: "0.75rem 0 0.55rem", fontSize: "0.9rem" }}>
              {client.siteIds.length} site{client.siteIds.length === 1 ? "" : "s"} • {client.members.length} members
            </p>
            <Link href={`/organizations/${client.id}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
              Open client detail →
            </Link>
          </article>
        ))}
      </section>
    </div>
  );
}
