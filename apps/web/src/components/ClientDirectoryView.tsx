"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRightIcon } from "@/components/JongoIcons";

type ClientItem = {
  id: string;
  name: string;
  summary: string;
  siteCount: number;
  memberCount: number;
  href: string;
};

export default function ClientDirectoryView({ clients }: { clients: ClientItem[] }) {
  const [search, setSearch] = useState("");
  const [siteFilter, setSiteFilter] = useState<"all" | "with-apps" | "empty">("all");
  const [view, setView] = useState<"list" | "grid">("list");

  const query = search.trim().toLowerCase();
  const filtered = clients.filter((client) => {
    const matchesQuery =
      query.length === 0 ||
      client.name.toLowerCase().includes(query) ||
      client.summary.toLowerCase().includes(query);

    const matchesSites =
      siteFilter === "all" ||
      (siteFilter === "with-apps" && client.siteCount > 0) ||
      (siteFilter === "empty" && client.siteCount === 0);

    return matchesQuery && matchesSites;
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
            placeholder="Filter clients by name or summary"
            aria-label="Filter clients"
          />
          <div className="filter-group" aria-label="Client filters">
            <button type="button" className={`filter-pill ${siteFilter === "all" ? "is-active" : ""}`} onClick={() => setSiteFilter("all")}>All</button>
            <button type="button" className={`filter-pill ${siteFilter === "with-apps" ? "is-active" : ""}`} onClick={() => setSiteFilter("with-apps")}>With apps</button>
            <button type="button" className={`filter-pill ${siteFilter === "empty" ? "is-active" : ""}`} onClick={() => setSiteFilter("empty")}>No apps</button>
          </div>
        </div>

        <div className="view-toggle" aria-label="Client view toggle">
          <button type="button" className={`view-pill ${view === "list" ? "is-active" : ""}`} onClick={() => setView("list")}>List</button>
          <button type="button" className={`view-pill ${view === "grid" ? "is-active" : ""}`} onClick={() => setView("grid")}>Grid</button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card directory-empty">
          <p className="card-muted">No clients match those filters.</p>
        </div>
      ) : (
        <section className={`directory-results ${view === "list" ? "directory-list" : "directory-grid"}`}>
          {filtered.map((client) => (
            <article key={client.id} className="card tone-card directory-row">
              <div className="directory-main">
                <div className="directory-title-row">
                  <h2 className="directory-title">{client.name}</h2>
                </div>
                <p className="directory-summary">{client.summary}</p>
                <div className="directory-badges">
                  <span className="tag">{client.siteCount} app{client.siteCount === 1 ? "" : "s"}</span>
                  <span className="tag">{client.memberCount} member{client.memberCount === 1 ? "" : "s"}</span>
                </div>
              </div>

              <div className="directory-actions">
                <Link href={client.href} className="action-link">
                  Open client <ArrowRightIcon className="btn-icon" />
                </Link>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}