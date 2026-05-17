import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, getSiteWorkspace } from "@/lib/repositories";
import CreateSiteForm from "@/components/CreateSiteForm";
import { ArrowRightIcon } from "@/components/JongoIcons";

type Params = { params: Promise<{ clientId: string }> };

export default async function ClientAppsPage({ params }: Params) {
  const { clientId } = await params;
  const session = await auth();

  const client = await getClientWorkspace(clientId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }

  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const sites = await Promise.all(client.siteIds.map((siteId) => getSiteWorkspace(siteId, viewer)));
  const apps = sites.filter((site): site is NonNullable<typeof site> => Boolean(site));

  return (
    <div className="page-stack">
      <div className="card" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Apps</h2>
          <p className="card-muted" style={{ marginTop: "0.35rem" }}>All apps mapped to this client workspace.</p>
        </div>
        {client.dbId ? <CreateSiteForm organizationId={client.dbId} /> : null}
      </div>

      <article className="card">
        {apps.length === 0 ? (
          <p className="card-muted">No apps yet. Create the first app for this client.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.65rem" }}>
            {apps.map((app) => (
              <div
                key={app.id}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.65rem", flexWrap: "wrap" }}
              >
                <Link href={`/apps/${app.slug ?? app.id}`} className="action-link" style={{ fontWeight: 600 }}>
                  {app.name} <ArrowRightIcon className="btn-icon" />
                </Link>
                <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                  <span className={`status-chip ${app.status}`}>{app.status}</span>
                  {app.ownershipState !== "mapped" ? (
                    <span className="tag tag-warning" style={{ fontSize: "0.75rem" }}>{app.ownershipDiagnostic}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
