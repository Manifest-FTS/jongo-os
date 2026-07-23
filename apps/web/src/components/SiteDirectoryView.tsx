"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRightIcon, BuildingOfficeIcon, StarIcon } from "@/components/JongoIcons";
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
  isStagingResource?: boolean;
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
  userId,
  isCollaboratorView = false
}: {
  sites: SiteItem[];
  userId?: string;
  isCollaboratorView?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [favoriteBusyId, setFavoriteBusyId] = useState<string | null>(null);
  const { prefs, setPrefs, ready } = useAppDirectoryPreferences(userId);

  // Derive available resource types from current site list (only show types with at least one match)
  const availableTypes = RESOURCE_TYPES.filter((t) => hasSomeType(sites, t));

  const resourceTypeFilters = prefs.resourceTypeFilters;
  const statusFilters = prefs.statusFilters;
  const stagingFilter = prefs.stagingFilter;
  const view = prefs.view;

  // Remove stale type filters if the current list no longer contains that type.
  useEffect(() => {
    if (!ready) return;

    const nextTypeFilters = resourceTypeFilters.filter((type) => hasSomeType(sites, type));
    if (nextTypeFilters.length !== resourceTypeFilters.length) {
      setPrefs({ resourceTypeFilters: nextTypeFilters });
    }
  }, [ready, resourceTypeFilters, sites, setPrefs]);

  useEffect(() => {
    if (!userId) {
      setFavoriteIds(new Set());
      return;
    }

    let cancelled = false;
    const visibleIds = new Set(sites.map((site) => site.id));

    async function loadFavorites() {
      try {
        const res = await fetch("/api/user/favorites/apps", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || cancelled) {
          return;
        }

        const appIds = Array.isArray((data as { appIds?: unknown[] }).appIds)
          ? ((data as { appIds: string[] }).appIds)
          : [];
        setFavoriteIds(new Set(appIds.filter((id) => visibleIds.has(id))));
      } catch {
        if (!cancelled) {
          setFavoriteIds(new Set());
        }
      }
    }

    void loadFavorites();

    return () => {
      cancelled = true;
    };
  }, [userId, sites]);

  async function toggleFavorite(siteId: string) {
    if (!userId || favoriteBusyId) return;

    const isFavorite = favoriteIds.has(siteId);
    const nextFavorited = !isFavorite;
    setFavoriteBusyId(siteId);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (nextFavorited) {
        next.add(siteId);
      } else {
        next.delete(siteId);
      }
      return next;
    });

    try {
      const res = await fetch("/api/user/favorites/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: siteId, favorited: nextFavorited })
      });

      if (!res.ok) {
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          if (isFavorite) {
            next.add(siteId);
          } else {
            next.delete(siteId);
          }
          return next;
        });
      }
    } catch {
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (isFavorite) {
          next.add(siteId);
        } else {
          next.delete(siteId);
        }
        return next;
      });
    } finally {
      setFavoriteBusyId(null);
    }
  }

  function toggleStatusFilter(value: "healthy" | "degraded" | "error" | "unknown") {
    const next = statusFilters.includes(value)
      ? statusFilters.filter((entry) => entry !== value)
      : [...statusFilters, value];
    setPrefs({ statusFilters: next });
  }

  function toggleTypeFilter(value: ResourceType) {
    const next = resourceTypeFilters.includes(value)
      ? resourceTypeFilters.filter((entry) => entry !== value)
      : [...resourceTypeFilters, value];
    setPrefs({ resourceTypeFilters: next });
  }

  const query = search.trim().toLowerCase();
  const filtered = sites.filter((site) => {
    const matchesQuery =
      query.length === 0 ||
      site.name.toLowerCase().includes(query) ||
      site.clientName.toLowerCase().includes(query) ||
      site.description?.toLowerCase().includes(query);

    const matchesStatus = statusFilters.length === 0 || statusFilters.includes(site.status);

    const matchesType = resourceTypeFilters.length === 0 || resourceTypeFilters.includes(site.resourceType as ResourceType);

    const isStaging = Boolean(site.isStagingResource);
    const matchesStaging =
      stagingFilter === "all" ||
      (stagingFilter === "only_staging" && isStaging) ||
      (stagingFilter === "exclude_staging" && !isStaging);

    return matchesQuery && matchesStatus && matchesType && matchesStaging;
  });

  return (
    <div className="page-stack">
      <div className="card directory-toolbar" style={{ gap: "0.75rem", display: "grid" }}>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="directory-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter apps by name, client, or description"
            aria-label="Filter apps"
            style={{ flex: "2 1 280px", minWidth: "220px" }}
          />
          <div className="filter-group" aria-label="Site status filters" style={{ flexWrap: "wrap", flex: "1 1 500px" }}>
            <button type="button" className={`filter-pill ${statusFilters.length === 0 ? "is-active" : ""}`} onClick={() => setPrefs({ statusFilters: [] })}>All</button>
            <button type="button" className={`filter-pill ${statusFilters.includes("healthy") ? "is-active" : ""}`} onClick={() => toggleStatusFilter("healthy")}>On track</button>
            <button type="button" className={`filter-pill ${statusFilters.includes("degraded") ? "is-active" : ""}`} onClick={() => toggleStatusFilter("degraded")}>Needs review</button>
            <button type="button" className={`filter-pill ${statusFilters.includes("error") ? "is-active" : ""}`} onClick={() => toggleStatusFilter("error")}>Action needed</button>
            <button type="button" className={`filter-pill ${statusFilters.includes("unknown") ? "is-active" : ""}`} onClick={() => toggleStatusFilter("unknown")}>Unavailable</button>
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          {availableTypes.length > 0 ? (
            <div className="filter-group" aria-label="Resource type filters" style={{ flexWrap: "wrap" }}>
              <button
                type="button"
                className={`filter-pill ${resourceTypeFilters.length === 0 ? "is-active" : ""}`}
                onClick={() => setPrefs({ resourceTypeFilters: [] })}
              >
                {RESOURCE_TYPE_LABELS["all"]}
              </button>
              {availableTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`filter-pill ${resourceTypeFilters.includes(type) ? "is-active" : ""}`}
                  onClick={() => toggleTypeFilter(type)}
                >
                  {RESOURCE_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          ) : null}

          <div className="filter-group" aria-label="Staging filters" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className={`filter-pill ${stagingFilter === "all" ? "is-active" : ""}`}
              onClick={() => setPrefs({ stagingFilter: "all" })}
            >
              All Envs
            </button>
            <button
              type="button"
              className={`filter-pill ${stagingFilter === "exclude_staging" ? "is-active" : ""}`}
              onClick={() => setPrefs({ stagingFilter: "exclude_staging" })}
            >
              Production
            </button>
            <button
              type="button"
              className={`filter-pill ${stagingFilter === "only_staging" ? "is-active" : ""}`}
              onClick={() => setPrefs({ stagingFilter: "only_staging" })}
            >
              Staging
            </button>
          </div>

          <div className="view-toggle" aria-label="Site view toggle">
            <button type="button" className={`view-pill ${view === "list" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "list" })}>List</button>
            <button type="button" className={`view-pill ${view === "grid" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "grid" })}>Grid</button>
          </div>
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
            const isFavorite = favoriteIds.has(site.id);
            return (
              <article key={site.id} className="card tone-card directory-row">
                <div className="directory-main">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.45rem", flexWrap: "wrap" }}>
                    <ResourceTypePill type={resolvedType} size="sm" />
                    <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                      <button
                        type="button"
                        onClick={() => toggleFavorite(site.id)}
                        disabled={!userId || favoriteBusyId === site.id}
                        aria-label={isFavorite ? `Remove ${site.name} from favorites` : `Favorite ${site.name}`}
                        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                        style={{
                          width: "1.95rem",
                          height: "1.95rem",
                          borderRadius: "999px",
                          border: "1px solid var(--border)",
                          background: isFavorite ? "#fff7db" : "var(--card, #ffffff)",
                          color: isFavorite ? "#d97706" : "var(--muted)",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer"
                        }}
                      >
                        <StarIcon filled={isFavorite} style={{ width: "0.98rem", height: "0.98rem" }} />
                      </button>
                      {!isCollaboratorView ? <span className={`status-chip ${state.tone}`}>{state.label}</span> : null}
                    </div>
                  </div>
                  <div className="directory-title-row">
                    <h2 className="directory-title" style={{ fontSize: "1.06rem", lineHeight: 1.2 }}>{site.name}</h2>
                  </div>
                  {site.description ? <p className="directory-summary">{site.description}</p> : null}
                  <p className="directory-meta" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                    <BuildingOfficeIcon style={{ width: "0.9rem", height: "0.9rem", color: "var(--muted)" }} />
                    <span>{site.clientName}</span>
                  </p>
                  {!isCollaboratorView && (site.backupLocalStatus || site.backupOffsiteLabel) ? (
                    <div className="directory-badges">
                      {site.backupLocalStatus ? <span className="tag">Backup: {site.backupLocalStatus}</span> : null}
                      {site.backupOffsiteLabel ? <span className={`status-chip ${site.backupOffsiteTone ?? "unknown"}`}>Offsite: {site.backupOffsiteLabel}</span> : null}
                    </div>
                  ) : null}
                  {!isCollaboratorView && (site.stagingEnvironmentReady !== undefined || site.stagingTargetAttached !== undefined) ? (
                    <div className="directory-badges">
                      <span className={`status-chip ${site.stagingEnvironmentReady ? "healthy" : "unknown"}`}>
                        {site.stagingEnvironmentReady ? "Env created" : "Env missing"}
                      </span>
                      <span className={`status-chip ${site.stagingTargetAttached ? "healthy" : "degraded"}`}>
                        {site.stagingTargetAttached ? "Target attached" : "Target missing"}
                      </span>
                    </div>
                  ) : null}
                  {!isCollaboratorView && site.backupCheckedAt ? (
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.76rem", color: "var(--muted)" }}>
                      Backup status checked {formatAgo(site.backupCheckedAt)}
                    </p>
                  ) : null}
                  {!isCollaboratorView && site.stagingCheckedAt ? (
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.76rem", color: "var(--muted)" }}>
                      Staging status checked {formatAgo(site.stagingCheckedAt)}
                    </p>
                  ) : null}
                  {!isCollaboratorView && site.showInternalMetadata ? (
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