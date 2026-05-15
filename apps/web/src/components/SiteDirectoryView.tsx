"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRightIcon } from "@/components/JongoIcons";

type SiteItem = {
  id: string;
  name: string;
  description?: string;
  clientId: string;
  clientName: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  source: "db" | "coolify";
  href: string;
  clientHref?: string;
};

export default function SiteDirectoryView({
  sites,
  mode
}: {
  sites: SiteItem[];
  mode: "live" | "mock";
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | SiteItem["status"]>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | SiteItem["source"]>("all");
  const [view, setView] = useState<"list" | "grid">("list");

  const query = search.trim().toLowerCase();
  const filtered = sites.filter((site) => {
    const matchesQuery =
      query.length === 0 ||
      site.name.toLowerCase().includes(query) ||
      site.clientName.toLowerCase().includes(query) ||
      site.description?.toLowerCase().includes(query);

    const matchesStatus = statusFilter === "all" || site.status === statusFilter;
    const matchesSource = sourceFilter === "all" || site.source === sourceFilter;

    return matchesQuery && matchesStatus && matchesSource;
  });

  return (
    <div className="page-stack">
      <div className="card directory-toolbar">
        <div className="directory-toolbar-primary">
          <input
            className="directory-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter sites by name, client, or description"
            aria-label="Filter sites"
          />
          <div className="filter-group" aria-label="Site status filters">
            <button type="button" className={`filter-pill ${statusFilter === "all" ? "is-active" : ""}`} onClick={() => setStatusFilter("all")}>All</button>
            <button type="button" className={`filter-pill ${statusFilter === "healthy" ? "is-active" : ""}`} onClick={() => setStatusFilter("healthy")}>Healthy</button>
            <button type="button" className={`filter-pill ${statusFilter === "degraded" ? "is-active" : ""}`} onClick={() => setStatusFilter("degraded")}>Degraded</button>
            <button type="button" className={`filter-pill ${statusFilter === "error" ? "is-active" : ""}`} onClick={() => setStatusFilter("error")}>Error</button>
          </div>
          <div className="filter-group" aria-label="Site source filters">
            <button type="button" className={`filter-pill ${sourceFilter === "all" ? "is-active" : ""}`} onClick={() => setSourceFilter("all")}>All sources</button>
            <button type="button" className={`filter-pill ${sourceFilter === "coolify" ? "is-active" : ""}`} onClick={() => setSourceFilter("coolify")}>Coolify</button>
            <button type="button" className={`filter-pill ${sourceFilter === "db" ? "is-active" : ""}`} onClick={() => setSourceFilter("db")}>Mapped</button>
          </div>
        </div>

        <div className="view-toggle" aria-label="Site view toggle">
          <button type="button" className={`view-pill ${view === "list" ? "is-active" : ""}`} onClick={() => setView("list")}>List</button>
          <button type="button" className={`view-pill ${view === "grid" ? "is-active" : ""}`} onClick={() => setView("grid")}>Grid</button>
        </div>
      </div>

      <p className="card-muted">{filtered.length} result{filtered.length === 1 ? "" : "s"} · {mode} mode</p>

      {filtered.length === 0 ? (
        <div className="card directory-empty">
          <p className="card-muted">No sites match those filters.</p>
        </div>
      ) : (
        <section className={`directory-results ${view === "list" ? "directory-list" : "directory-grid"}`}>
          {filtered.map((site) => (
            <article key={site.id} className="card tone-card directory-row">
              <div className="directory-main">
                <div className="directory-title-row">
                  <h2 className="directory-title">{site.name}</h2>
                  <span className={`status-chip ${site.status}`}>{site.status}</span>
                  <span className="tag">{site.source}</span>
                </div>
                {site.description ? <p className="directory-summary">{site.description}</p> : null}
                <p className="directory-meta">Client: {site.clientName}</p>
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
          ))}
        </section>
      )}
    </div>
  );
}