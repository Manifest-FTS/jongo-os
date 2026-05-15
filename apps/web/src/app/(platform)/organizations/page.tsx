import Link from "next/link";
import { listClientWorkspaces } from "@/lib/repositories";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";
import { auth } from "@/lib/auth.config";
import { ArrowRightIcon } from "@/components/JongoIcons";

export default async function OrganizationsPage() {
  const session = await auth();
  const clients = await listClientWorkspaces(session?.user?.id);

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Clients</p>
          <h1 style={{ margin: 0 }}>Client Directory</h1>
          <p className="card-muted" style={{ marginTop: "0.35rem" }}>
            Manage client workspaces, teams, and site ownership.
          </p>
        </div>
        <div style={{ flexShrink: 0, paddingTop: "0.25rem" }}>
          <CreateOrganizationForm />
        </div>
      </div>
      {clients.length === 0 ? (
        <div className="card">
          <p className="card-muted">No client workspaces yet. Create one above to get started.</p>
          <p className="form-help" style={{ marginTop: "0.65rem" }}>
            After creating a client, add sites and invite collaborators from the client detail page.
          </p>
        </div>
      ) : (
        <section className="grid">
          {clients.map((client) => (
            <article key={client.id} className="card">
              <h3 className="card-title">{client.name}</h3>
              <p className="card-muted">{client.summary}</p>
              <p style={{ margin: "0.75rem 0 0.55rem", fontSize: "0.9rem" }}>
                {client.siteCount} site{client.siteCount === 1 ? "" : "s"} | {client.memberCount} members
              </p>
              <Link href={`/organizations/${client.id}`} className="action-link">
                Open client detail <ArrowRightIcon className="btn-icon" />
              </Link>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
