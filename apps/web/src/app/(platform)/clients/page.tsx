import { auth } from "@/lib/auth.config";
import { listClientWorkspaces, listSiteDirectory } from "@/lib/repositories";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { describeForViewer } from "@/lib/site-description";
import Link from "next/link";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";
import ClientDirectoryView from "@/components/ClientDirectoryView";
import UnmappedCoolifyProjectsBanner from "@/components/UnmappedCoolifyProjectsBanner";

export default async function ClientsPage() {
  const session = await auth();
  const isPlatformAdmin = await isPlatformAdminEmail(session?.user?.email);
  const clients = await listClientWorkspaces({
    userId: session?.user?.id,
    email: session?.user?.email
  });
  const visibleSites = clients.length > 0 && clients[0].dataSource === "db"
    ? await listSiteDirectory({ userId: session?.user?.id, email: session?.user?.email })
    : [];
  const siteCountsByClientId = new Map<string, number>();
  for (const site of visibleSites) {
    siteCountsByClientId.set(site.clientId, (siteCountsByClientId.get(site.clientId) ?? 0) + 1);
  }

  const isMock = clients.length > 0 && clients[0].dataSource === "mock";

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Clients ({clients.length})</h1>
          <p className="page-subtitle">Workspaces, contacts, and app ownership.</p>
        </div>
        <div className="page-head-actions">
          <CreateOrganizationForm />
        </div>
      </div>

      {isMock && (
        <div className="diagnostic-banner">
          <strong>Demo client list active.</strong> Live client data is currently unavailable, so sample clients are shown.
          <span> Verify database and provider connectivity in </span>
          <Link href="/settings#runtime-diagnostics" className="action-link">Platform Settings</Link>
          <span>.</span>
        </div>
      )}

      {isPlatformAdmin ? <UnmappedCoolifyProjectsBanner /> : null}

      {clients.length === 0 ? (
        <div className="card">
          <p className="card-muted">No client workspaces yet. Create one above to get started.</p>
          <p className="form-help" style={{ marginTop: "0.65rem" }}>
            After creating a client, add apps and invite collaborators from the client detail page.
          </p>
        </div>
      ) : (
        <ClientDirectoryView
          clients={clients.map((client) => ({
            id: client.id,
            name: client.name,
            summary: describeForViewer(client.summary, isPlatformAdmin) ?? "Client workspace",
            siteCount: siteCountsByClientId.get(client.id) ?? client.siteCount,
            memberCount: client.memberCount,
            href: `/clients/${client.id}`
          }))}
        />
      )}
    </div>
  );
}
