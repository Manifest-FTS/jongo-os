import Link from "next/link";
import { getCoolifyOverview } from "@/lib/coolify";
import { listSiteDirectory } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { ArrowRightIcon } from "@/components/JongoIcons";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";
import SiteDirectoryView from "@/components/SiteDirectoryView";

export default async function SitesPage() {
  const session = await auth();
  const overview = await getCoolifyOverview();
  const siteDirectory = await listSiteDirectory({
    userId: session?.user?.id,
    email: session?.user?.email
  });

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Sites ({siteDirectory.length})</h1>
          <p className="page-subtitle">Filter by name or health and switch between list and grid as needed.</p>
        </div>
      </div>

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
        <SiteDirectoryView
          sites={siteDirectory.map((site) => {
            const overviewSite = overview.sites.find((item) => item.id === site.coolifyServiceUuid || item.id === site.id);

            return {
              id: site.id,
              name: site.name,
              description: site.description,
              clientId: site.clientId,
              clientName: site.clientName,
              status: overviewSite?.status ?? site.status,
              ownershipState: site.ownershipState,
              coolifyProjectName: site.coolifyProjectName,
              source: site.source,
              href: `/sites/${site.id}`,
              clientHref: site.ownershipState === "mapped" ? `/organizations/${site.clientId}` : undefined
            };
          })}
        />
      )}
    </div>
  );
}
