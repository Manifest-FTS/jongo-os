import Link from "next/link";
import { listClientWorkspaces } from "@/lib/repositories";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";
import { auth } from "@/lib/auth.config";
import { ArrowRightIcon } from "@/components/JongoIcons";
import ClientDirectoryView from "@/components/ClientDirectoryView";

export default async function OrganizationsPage() {
  const session = await auth();
  const clients = await listClientWorkspaces({
    userId: session?.user?.id,
    email: session?.user?.email
  });

  const isMock = clients.length > 0 && clients[0].dataSource === "mock";

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Clients ({clients.length})</h1>
          <p className="page-subtitle">Workspaces, contacts, and site ownership.</p>
        </div>
        <div className="page-head-actions">
          <CreateOrganizationForm />
        </div>
      </div>

      {isMock && (
        <div className="diagnostic-banner">
          <strong>Mock data active.</strong> A database query failed, so hardcoded sample clients are shown.
          Check server logs for the exact cause (for example network/tunnel issues, UUID mismatch in query inputs, or a migration-required schema mismatch such as missing columns).
        </div>
      )}
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
            summary: client.summary,
            siteCount: client.siteCount,
            memberCount: client.memberCount,
            href: `/organizations/${client.id}`
          }))}
        />
      )}
    </div>
  );
}
