"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRightIcon } from "@/components/JongoIcons";
import ResourceTypePill from "@/components/ResourceTypePill";
import { useAppDirectoryPreferences } from "@/hooks/useAppDirectoryPreferences";
import { RESOURCE_TYPES, type ResourceType } from "@/lib/resource-types";

type SiteItem = {
  id: string;
  name: string;
  description?: string;
  clientId: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  ownershipState: "mapped" | "orphaned" | "unavailable";
  ownershipDiagnostic: string;
  source: "db" | "coolify";
  href: string;
  clientHref?: string;
  resourceType?: string;
  showInternalMetadata?: boolean;
  backupLocalStatus?: string;
  backupOffsiteLabel?: string;
  backupOffsiteTone?: "healthy" | "degraded" | "unknown";
  backupCheckedAt?: string;
  stagingEnvironmentReady?: boolean;
  stagingTargetAttached?: boolean;
  stagingCheckedAt?: string;
};

const RESOURCE_TYPE_LABELS: Record<ResourceType | "all", string> = {
  all: "All Types",
  WordPress: "WordPress",
  "Web App": "Web App",
  Database: "Database",
  Service: "Service",
  "Mobile App": "Mobile",
  "Unknown/Other": "Unknown"
};

function isKnownResourceType(value: string | undefined): value is ResourceType {
  if (!value) return false;
  return RESOURCE_TYPES.includes(value as ResourceType);
}

function hasSomeType(sites: SiteItem[], type: ResourceType): boolean {
  return sites.some((s) => s.resourceType === type);
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusCopy(status: SiteItem["status"]): { label: string; tone: string } {
  if (status === "healthy") return { label: "On track", tone: "healthy" };
  if (status === "degraded") return { label: "Needs review", tone: "degraded" };
  if (status === "error") return { label: "Action needed", tone: "error" };
  return { label: "Unavailable", tone: "unknown" };
}

export default function SiteDirectoryView({
  sites,
  userId
}: {
  sites: SiteItem[];
  userId?: string;
}) {
  const [search, setSearch] = useState("");
  const { prefs, setPrefs, ready } = useAppDirectoryPreferences(userId);

  // Derive available resource types from current site list (only show types with at least one match)
  const availableTypes = RESOURCE_TYPES.filter((t) => hasSomeType(sites, t));

  const resourceTypeFilter = prefs.resourceTypeFilter;
  const statusFilter = prefs.statusFilter;
  const view = prefs.view;

  // Reset resource type filter if it no longer matches available types
  useEffect(() => {
    if (ready && resourceTypeFilter !== "all" && !hasSomeType(sites, resourceTypeFilter)) {
      setPrefs({ resourceTypeFilter: "all" });
    }
  }, [ready, resourceTypeFilter, sites, setPrefs]);

  const query = search.trim().toLowerCase();
  const filtered = sites.filter((site) => {
    const matchesQuery =
      query.length === 0 ||
      site.name.toLowerCase().includes(query) ||
      site.clientName.toLowerCase().includes(query) ||
      site.description?.toLowerCase().includes(query);

    const matchesStatus = statusFilter === "all" || site.status === statusFilter;

    const matchesType =
      resourceTypeFilter === "all" ||
      site.resourceType === resourceTypeFilter;

    return matchesQuery && matchesStatus && matchesType;
  });

  return (
    <div className="page-stack">
      <div className="card directory-toolbar" style={{ gap: "0.75rem" }}>
        <div className="directory-toolbar-primary">
          <input
            className="directory-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter apps by name, client, or description"
            aria-label="Filter apps"
          />
          <div className="filter-group" aria-label="Site status filters">
            <button type="button" className={`filter-pill ${statusFilter === "all" ? "is-active" : ""}`} onClick={() => setPrefs({ statusFilter: "all" })}>All</button>
            <button type="button" className={`filter-pill ${statusFilter === "healthy" ? "is-active" : ""}`} onClick={() => setPrefs({ statusFilter: "healthy" })}>On track</button>
            <button type="button" className={`filter-pill ${statusFilter === "degraded" ? "is-active" : ""}`} onClick={() => setPrefs({ statusFilter: "degraded" })}>Needs review</button>
            <button type="button" className={`filter-pill ${statusFilter === "error" ? "is-active" : ""}`} onClick={() => setPrefs({ statusFilter: "error" })}>Action needed</button>
            <button type="button" className={`filter-pill ${statusFilter === "unknown" ? "is-active" : ""}`} onClick={() => setPrefs({ statusFilter: "unknown" })}>Unavailable</button>
          </div>
        </div>

        {availableTypes.length > 0 && (
          <div className="filter-group" aria-label="Resource type filters" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className={`filter-pill ${resourceTypeFilter === "all" ? "is-active" : ""}`}
              onClick={() => setPrefs({ resourceTypeFilter: "all" })}
            >
              {RESOURCE_TYPE_LABELS["all"]}
            </button>
            {availableTypes.map((type) => (
              <button
                key={type}
                type="button"
                className={`filter-pill ${resourceTypeFilter === type ? "is-active" : ""}`}
                onClick={() => setPrefs({ resourceTypeFilter: type })}
              >
                {RESOURCE_TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        )}

        <div className="view-toggle" aria-label="Site view toggle">
          <button type="button" className={`view-pill ${view === "list" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "list" })}>List</button>
          <button type="button" className={`view-pill ${view === "grid" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "grid" })}>Grid</button>
        </div>
      </div>

      <p className="card-muted">{filtered.length} app{filtered.length === 1 ? "" : "s"}</p>

      {filtered.length === 0 ? (
        <div className="card directory-empty">
          <p className="card-muted">No apps match those filters.</p>
        </div>
      ) : (
        <section className={`directory-results ${view === "list" ? "directory-list" : "directory-grid"}`}>
          {filtered.map((site) => {
            const resolvedType = isKnownResourceType(site.resourceType) ? site.resourceType : "Web App";
            const state = statusCopy(site.status);
            return (
              <article key={site.id} className="card tone-card directory-row">
                <div className="directory-main">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.45rem", flexWrap: "wrap" }}>
                    <ResourceTypePill type={resolvedType} size="sm" />
                    <span className={`status-chip ${state.tone}`}>{state.label}</span>
                  </div>
                  <div className="directory-title-row">
                    <h2 className="directory-title" style={{ fontSize: "1.06rem", lineHeight: 1.2 }}>{site.name}</h2>
                  </div>
                  {site.description ? <p className="directory-summary">{site.description}</p> : null}
                  <p className="directory-meta">Client: {site.clientName}</p>
                  {(site.backupLocalStatus || site.backupOffsiteLabel) ? (
                    <div className="directory-badges">
                      {site.backupLocalStatus ? <span className="tag">Backup: {site.backupLocalStatus}</span> : null}
                      {site.backupOffsiteLabel ? <span className={`status-chip ${site.backupOffsiteTone ?? "unknown"}`}>Offsite: {site.backupOffsiteLabel}</span> : null}
                    </div>
                  ) : null}
                  {(site.stagingEnvironmentReady !== undefined || site.stagingTargetAttached !== undefined) ? (
                    <div className="directory-badges">
                      <span className={`status-chip ${site.stagingEnvironmentReady ? "healthy" : "unknown"}`}>
                        {site.stagingEnvironmentReady ? "Env created" : "Env missing"}
                      </span>
                      <span className={`status-chip ${site.stagingTargetAttached ? "healthy" : "degraded"}`}>
                        {site.stagingTargetAttached ? "Target attached" : "Target missing"}
                      </span>
                    </div>
                  ) : null}
                  {site.backupCheckedAt ? (
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.76rem", color: "var(--muted)" }}>
                      Backup status checked {formatAgo(site.backupCheckedAt)}
                    </p>
                  ) : null}
                  {site.stagingCheckedAt ? (
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.76rem", color: "var(--muted)" }}>
                      Staging status checked {formatAgo(site.stagingCheckedAt)}
                    </p>
                  ) : null}
                  {site.showInternalMetadata ? (
                    <div className="directory-badges">
                      <span className={`tag ${site.ownershipState === "mapped" ? "tag-mapped" : "tag-warning"}`}>
                        Ownership: {site.ownershipState === "mapped" ? "mapped" : "mapping needs review"}
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="directory-actions">
                  {site.clientHref ? (
                    <Link href={site.clientHref} className="action-link">
                      View client <ArrowRightIcon className="btn-icon" />
                    </Link>
                  ) : null}
                  <Link href={site.href} className="action-link">
                    Open workspace <ArrowRightIcon className="btn-icon" />
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}