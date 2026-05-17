import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import PendingBadge from "@/components/PendingBadge";
import { getClientTeamMembers, getClientWorkspace } from "@/lib/repositories";

type Params = { params: Promise<{ clientId: string }> };

export default async function ClientTeamPage({ params }: Params) {
  const { clientId } = await params;
  const session = await auth();

  const client = await getClientWorkspace(clientId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }

  const team = client.dbId ? await getClientTeamMembers(client.dbId) : [];

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          Client Team
          <PendingBadge reason="Organization-level team management pending; manage collaborators per app." />
        </h2>
        <p className="card-muted" style={{ marginBottom: "1rem" }}>
          This tab shows organization-level members from the system. App team management is handled per app — each app can have its own set of collaborators. To invite users, go to the Team tab within an app.
        </p>

        {team.length === 0 ? (
          <p className="card-muted">No organization-level collaborators found.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.55rem" }}>
            {team.map((member) => (
              <div key={member.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", borderBottom: "1px solid var(--border)", paddingBottom: "0.45rem" }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>{member.name}</p>
                  <p style={{ margin: 0, fontSize: "0.83rem", color: "var(--muted)" }}>{member.email}</p>
                </div>
                <span className="tag">{member.role}</span>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
