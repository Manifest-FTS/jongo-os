"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BuildingOfficeIcon, SettingsIcon, StarIcon } from "@/components/JongoIcons";
import ResourceTypePill from "@/components/ResourceTypePill";
import { ToastStack, useToasts } from "@/components/Toasts";
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
  isCollaboratorView = false,
  toolbarMode = "full",
  gridColumns = 3
}: {
  sites: SiteItem[];
  userId?: string;
  isCollaboratorView?: boolean;
  toolbarMode?: "full" | "view-only";
  gridColumns?: 2 | 3;
}) {
  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [favoriteBusyId, setFavoriteBusyId] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();
  const { prefs, setPrefs, ready } = useAppDirectoryPreferences(userId);

  // Derive available resource types from current site list (only show types with at least one match)
  const availableTypes = RESOURCE_TYPES.filter((t) => hasSomeType(sites, t));

  const resourceTypeFilters = prefs.resourceTypeFilters;
  const statusFilters = prefs.statusFilters;
  const stagingFilter = prefs.stagingFilter;
  const view = prefs.view;
  const activeFilterCount = statusFilters.length + resourceTypeFilters.length + (stagingFilter === "all" ? 0 : 1);
  const hasActiveFilters = activeFilterCount > 0;

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
        push({
          tone: "error",
          title: "Could not update favorite",
          text: "Please try again.",
          ttl: 5000
        });
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          if (isFavorite) {
            next.add(siteId);
          } else {
            next.delete(siteId);
          }
          return next;
        });
      } else {
        const siteName = sites.find((site) => site.id === siteId)?.name ?? "App";
        push({
          tone: "success",
          title: nextFavorited ? "App starred" : "App unstarred",
          text: nextFavorited
            ? `${siteName} was added to Starred apps.`
            : `${siteName} was removed from Starred apps.`
        });
      }
    } catch {
      push({
        tone: "error",
        title: "Could not update favorite",
        text: "Network error. Please try again.",
        ttl: 5000
      });
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

  function clearFilters() {
    setPrefs({
      statusFilters: [],
      resourceTypeFilters: [],
      stagingFilter: "all"
    });
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
      {toolbarMode === "view-only" ? (
        <div className="card directory-toolbar directory-toolbar--compact">
          <div className="directory-toolbar__inline">
            <p className="card-muted" style={{ margin: 0 }}>
              {filtered.length} app{filtered.length === 1 ? "" : "s"}
            </p>
            <div className="view-toggle" aria-label="Site view toggle">
              <button type="button" className={`view-pill ${view === "list" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "list" })}>List</button>
              <button type="button" className={`view-pill ${view === "grid" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "grid" })}>Grid</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="card directory-toolbar directory-toolbar--modern">
          <div className="directory-toolbar__row">
            <input
              className="directory-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter apps by name, client, or description"
              aria-label="Filter apps"
              style={{ flex: "1 1 auto", minWidth: "220px" }}
            />

            <button
              type="button"
              className="directory-filter-trigger"
              onClick={() => setFiltersOpen(true)}
              aria-label="Open filters"
            >
              <SettingsIcon style={{ width: "0.95rem", height: "0.95rem" }} />
              <span>Filter by</span>
              {hasActiveFilters ? <span className="directory-filter-count">{activeFilterCount}</span> : null}
            </button>

            <div className="view-toggle" aria-label="Site view toggle">
              <button type="button" className={`view-pill ${view === "list" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "list" })}>List</button>
              <button type="button" className={`view-pill ${view === "grid" ? "is-active" : ""}`} onClick={() => setPrefs({ view: "grid" })}>Grid</button>
            </div>
          </div>

          {hasActiveFilters ? (
            <div className="directory-active-filters">
              {statusFilters.map((status) => (
                <button key={status} type="button" className="directory-active-chip" onClick={() => toggleStatusFilter(status)}>
                  {status === "healthy" ? "On track" : status === "degraded" ? "Needs review" : status === "error" ? "Action needed" : "Unavailable"}
                  <span aria-hidden>×</span>
                </button>
              ))}
              {resourceTypeFilters.map((type) => (
                <button key={type} type="button" className="directory-active-chip" onClick={() => toggleTypeFilter(type)}>
                  {RESOURCE_TYPE_LABELS[type]}
                  <span aria-hidden>×</span>
                </button>
              ))}
              {stagingFilter !== "all" ? (
                <button type="button" className="directory-active-chip" onClick={() => setPrefs({ stagingFilter: "all" })}>
                  {stagingFilter === "only_staging" ? "Staging only" : "Production only"}
                  <span aria-hidden>×</span>
                </button>
              ) : null}
              <button type="button" className="directory-active-clear" onClick={clearFilters}>Clear all</button>
            </div>
          ) : null}
        </div>
      )}

      {toolbarMode === "full" && filtersOpen ? (
        <div className="directory-filter-sheet" role="dialog" aria-modal="true" aria-label="Filter apps">
          <button type="button" className="directory-filter-backdrop" aria-label="Close filters" onClick={() => setFiltersOpen(false)} />
          <div className="directory-filter-panel">
            <div className="directory-filter-panel__head">
              <h3 style={{ margin: 0, fontSize: "1rem" }}>Filter by</h3>
              <button type="button" className="directory-filter-close" onClick={() => setFiltersOpen(false)}>×</button>
            </div>

            <div className="directory-filter-section">
              <p className="directory-filter-label">Status</p>
              <div className="directory-filter-options">
                <label className="directory-filter-option">
                  <input type="checkbox" checked={statusFilters.length === 0} onChange={() => setPrefs({ statusFilters: [] })} />
                  <span>Any status</span>
                </label>
                <label className="directory-filter-option">
                  <input type="checkbox" checked={statusFilters.includes("healthy")} onChange={() => toggleStatusFilter("healthy")} />
                  <span>On track</span>
                </label>
                <label className="directory-filter-option">
                  <input type="checkbox" checked={statusFilters.includes("degraded")} onChange={() => toggleStatusFilter("degraded")} />
                  <span>Needs review</span>
                </label>
                <label className="directory-filter-option">
                  <input type="checkbox" checked={statusFilters.includes("error")} onChange={() => toggleStatusFilter("error")} />
                  <span>Action needed</span>
                </label>
                <label className="directory-filter-option">
                  <input type="checkbox" checked={statusFilters.includes("unknown")} onChange={() => toggleStatusFilter("unknown")} />
                  <span>Unavailable</span>
                </label>
              </div>
            </div>

            {availableTypes.length > 0 ? (
              <div className="directory-filter-section">
                <p className="directory-filter-label">Type</p>
                <div className="directory-filter-options">
                  <label className="directory-filter-option">
                    <input type="checkbox" checked={resourceTypeFilters.length === 0} onChange={() => setPrefs({ resourceTypeFilters: [] })} />
                    <span>All types</span>
                  </label>
                  {availableTypes.map((type) => (
                    <label key={type} className="directory-filter-option">
                      <input type="checkbox" checked={resourceTypeFilters.includes(type)} onChange={() => toggleTypeFilter(type)} />
                      <span>{RESOURCE_TYPE_LABELS[type]}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="directory-filter-section">
              <p className="directory-filter-label">Environment</p>
              <div className="directory-filter-options">
                <label className="directory-filter-option">
                  <input type="radio" name="env-filter" checked={stagingFilter === "all"} onChange={() => setPrefs({ stagingFilter: "all" })} />
                  <span>All environments</span>
                </label>
                <label className="directory-filter-option">
                  <input type="radio" name="env-filter" checked={stagingFilter === "exclude_staging"} onChange={() => setPrefs({ stagingFilter: "exclude_staging" })} />
                  <span>Production only</span>
                </label>
                <label className="directory-filter-option">
                  <input type="radio" name="env-filter" checked={stagingFilter === "only_staging"} onChange={() => setPrefs({ stagingFilter: "only_staging" })} />
                  <span>Staging only</span>
                </label>
              </div>
            </div>

            <div className="directory-filter-panel__foot">
              <button type="button" className="btn" onClick={clearFilters}>Reset</button>
              <button type="button" className="btn" onClick={() => setFiltersOpen(false)}>Apply</button>
            </div>
          </div>
        </div>
      ) : null}

      {toolbarMode === "full" ? <p className="card-muted">{filtered.length} app{filtered.length === 1 ? "" : "s"}</p> : null}

      {filtered.length === 0 ? (
        <div className="card directory-empty">
          <p className="card-muted">No apps match those filters.</p>
        </div>
      ) : (
        <section className={`directory-results ${view === "list" ? "directory-list" : `directory-grid ${gridColumns === 2 ? "directory-grid--two-up" : ""}`}`}>
          {filtered.map((site) => {
            const resolvedType = isKnownResourceType(site.resourceType) ? site.resourceType : "Web App";
            const state = statusCopy(site.status);
            const isFavorite = favoriteIds.has(site.id);
            return (
              <article key={site.id} className="card tone-card directory-row directory-row--linked">
                <Link href={site.href} className="directory-stretched-link" aria-label={`Open ${site.name} workspace`} />
                <div className="directory-main">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.45rem", flexWrap: "wrap" }}>
                    <ResourceTypePill type={resolvedType} size="sm" />
                    <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", position: "relative", zIndex: 2 }}>
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
                  {site.clientHref ? (
                    <Link
                      href={site.clientHref}
                      className="directory-meta directory-client-link"
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", position: "relative", zIndex: 2 }}
                    >
                      <BuildingOfficeIcon style={{ width: "0.9rem", height: "0.9rem", color: "var(--muted)" }} />
                      <span>{site.clientName}</span>
                    </Link>
                  ) : (
                    <p className="directory-meta" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                      <BuildingOfficeIcon style={{ width: "0.9rem", height: "0.9rem", color: "var(--muted)" }} />
                      <span>{site.clientName}</span>
                    </p>
                  )}
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
              </article>
            );
          })}
        </section>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} side="right" />
    </div>
  );
}