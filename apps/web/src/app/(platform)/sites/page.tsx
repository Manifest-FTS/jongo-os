import Link from "next/link";
import { getAppsEmptyStateMessage } from "@/lib/reason-messages";
import { getInventorySnapshot } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { ArrowRightIcon } from "@/components/JongoIcons";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";
import SiteDirectoryView from "@/components/SiteDirectoryView";

export const dynamic = "force-dynamic";

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function SitesPage() {
  const session = await auth();
  const inventory = await getInventorySnapshot({
    userId: session?.user?.id,
    email: session?.user?.email
  });
  const overview = inventory.overview;
  const siteDirectory = inventory.siteDirectory;

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Apps ({siteDirectory.length})</h1>
          <p className="page-subtitle">Filter by name or health and switch between list and grid as needed.</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
            <span className={`status-chip ${overview.mode}`}>{overview.mode}</span>
            {overview.mode === "live"
              ? (
                <>
                  Coolify · {formatAgo(overview.generatedAt)}
                  {overview.fetchError && siteDirectory.length === 0 && <span style={{ color: "var(--error, #c0392b)" }}>· API unavailable</span>}
                </>
              )
              : "Coolify not configured — demo mode"}
            {siteDirectory.length > 0 && (
              <span style={{ color: "var(--muted)" }}>
                · {siteDirectory.length} app{siteDirectory.length === 1 ? "" : "s"} visible ({inventory.counts.dbMappedVisibleSites} mapped, {inventory.counts.coolifyVisibleSites} live)
              </span>
            )}
          </p>
        </div>
      </div>

      {siteDirectory.length === 0 ? (
        <div className="card">
          {(() => {
            const emptyMsg = getAppsEmptyStateMessage(inventory.emptyReason);
            return (
              <>
                <p className="card-muted">{emptyMsg.heading}</p>
                <p className="form-help" style={{ marginBottom: "0.75rem" }}>
                  {emptyMsg.description}
                </p>
              </>
            );
          })()}
          <div style={{ marginBottom: "0.75rem" }}>
            <CreateOrganizationForm />
          </div>
          <p style={{ marginTop: "0.5rem" }}>
            <Link href="/clients" className="action-link">Manage clients <ArrowRightIcon className="btn-icon" /></Link>
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
              ownershipDiagnostic: site.ownershipDiagnostic,
              source: site.source,
              href: `/apps/${site.slug ?? site.id}`,
              clientHref: site.ownershipState === "mapped" ? `/clients/${site.clientId}` : undefined
            };
          })}
        />
      )}
    </div>
  );
}
