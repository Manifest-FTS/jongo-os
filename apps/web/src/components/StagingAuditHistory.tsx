"use client";

import { useEffect, useMemo, useState } from "react";

type StagingAuditHistoryItem = {
  id: string;
  createdAt: string;
  actionType?: string;
  message: string;
  domains: string[];
  preferredStagingDomain?: string;
};

type Props = {
  items: StagingAuditHistoryItem[];
};

type FilterMode = "all" | "domain-sync";

const INITIAL_VISIBLE_COUNT = 5;
const SHOW_MORE_STEP = 5;

function formatAuditAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatActionLabel(actionType?: string): string {
  switch (actionType) {
    case "staging_enable_requested":
      return "Staging enable requested";
    case "staging_enable_existing":
      return "Staging already present";
    case "staging_enable_provision":
      return "Staging provisioned";
    case "staging_disable_requested":
      return "Staging disable requested";
    case "staging_disable_destroy":
      return "Staging disabled and destroyed";
    case "staging_domains_updated":
      return "Staging domains updated";
    case "staging_domains_update_failed":
      return "Staging domains update failed";
    default:
      return actionType ?? "Staging action";
  }
}

function isDomainSyncAction(actionType?: string): boolean {
  return actionType === "staging_domains_updated" || actionType === "staging_domains_update_failed";
}

function formatAuditExportText(items: StagingAuditHistoryItem[]): string {
  return items
    .map((item) => {
      const lines = [
        `${formatActionLabel(item.actionType)} (${formatAuditAgo(item.createdAt)})`,
        `Message: ${item.message}`
      ];

      if (item.domains.length > 0) {
        lines.push(`Domains: ${item.domains.join(", ")}`);
      }

      if (item.preferredStagingDomain) {
        lines.push(`Preferred staging domain: ${item.preferredStagingDomain}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

export default function StagingAuditHistory({ items }: Props) {
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const [copyMessage, setCopyMessage] = useState("");

  const filteredItems = useMemo(() => {
    if (filterMode === "all") {
      return items;
    }

    return items.filter((item) => isDomainSyncAction(item.actionType));
  }, [items, filterMode]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
  }, [filterMode]);

  const visibleItems = filteredItems.slice(0, visibleCount);
  const canShowMore = visibleItems.length < filteredItems.length;
  const canShowLess = filteredItems.length > INITIAL_VISIBLE_COUNT && visibleCount > INITIAL_VISIBLE_COUNT;

  async function copyToClipboard(content: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopyStatus("success");
      setCopyMessage(successMessage);
    } catch {
      setCopyStatus("error");
      setCopyMessage("Unable to copy from this browser context.");
    }
  }

  async function copyAsJson() {
    await copyToClipboard(
      JSON.stringify(filteredItems, null, 2),
      `Copied ${filteredItems.length} filtered staging audit events as JSON.`
    );
  }

  async function copyAsText() {
    await copyToClipboard(
      formatAuditExportText(filteredItems),
      `Copied ${filteredItems.length} filtered staging audit events as text.`
    );
  }

  function downloadContent(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
    setCopyStatus("success");
    setCopyMessage(`Downloaded ${filename}.`);
  }

  function buildExportFilename(extension: "txt" | "json") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const scope = filterMode === "domain-sync" ? "domain-sync" : "all";
    return `staging-audit-${scope}-${stamp}.${extension}`;
  }

  function downloadAsText() {
    downloadContent(
      formatAuditExportText(filteredItems),
      buildExportFilename("txt"),
      "text/plain;charset=utf-8"
    );
  }

  function downloadAsJson() {
    downloadContent(
      JSON.stringify(filteredItems, null, 2),
      buildExportFilename("json"),
      "application/json;charset=utf-8"
    );
  }

  return (
    <article className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
        <h3 className="card-title" style={{ margin: 0 }}>Staging Audit History</h3>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button
            type="button"
            className={filterMode === "all" ? "button" : "button button-secondary"}
            onClick={() => setFilterMode("all")}
          >
            All
          </button>
          <button
            type="button"
            className={filterMode === "domain-sync" ? "button" : "button button-secondary"}
            onClick={() => setFilterMode("domain-sync")}
          >
            Domain sync
          </button>
        </div>
      </div>
      <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
        Recent staging enable, disable, and domain update actions recorded by Jongo.
      </p>

      {filteredItems.length > 0 ? (
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={copyAsText}
          >
            Copy text
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={copyAsJson}
          >
            Copy JSON
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={downloadAsText}
          >
            Download text
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={downloadAsJson}
          >
            Download JSON
          </button>
        </div>
      ) : null}

      {copyStatus !== "idle" ? (
        <p
          style={{
            margin: "0 0 0.75rem",
            fontSize: "0.8rem",
            color: copyStatus === "error" ? "var(--error, #c0392b)" : "var(--muted)"
          }}
        >
          {copyMessage}
        </p>
      ) : null}

      {filteredItems.length === 0 ? (
        <p className="card-muted" style={{ marginBottom: 0 }}>
          {filterMode === "domain-sync"
            ? "No domain sync events recorded yet."
            : "No staging audit events recorded yet."}
        </p>
      ) : (
        <>
          <div style={{ display: "grid", gap: "0.6rem" }}>
          {visibleItems.map((item) => (
            <div key={item.id} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
                <div>
                  <strong style={{ fontSize: "0.9rem" }}>{formatActionLabel(item.actionType)}</strong>
                  <p style={{ margin: "0.25rem 0 0", fontSize: "0.84rem", color: "var(--muted)" }}>{item.message}</p>
                </div>
                <span style={{ fontSize: "0.76rem", color: "var(--muted)" }}>{formatAuditAgo(item.createdAt)}</span>
              </div>
              {item.domains.length > 0 ? (
                <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem" }}>
                  Domains: {item.domains.join(", ")}
                </p>
              ) : null}
              {item.preferredStagingDomain ? (
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
                  Preferred staging domain: {item.preferredStagingDomain}
                </p>
              ) : null}
            </div>
          ))}
          </div>
          {(canShowMore || canShowLess) ? (
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.75rem" }}>
              {canShowLess ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setVisibleCount(INITIAL_VISIBLE_COUNT)}
                >
                  Show less
                </button>
              ) : null}
              {canShowMore ? (
                <button
                  type="button"
                  className="button"
                  onClick={() => setVisibleCount((current) => Math.min(current + SHOW_MORE_STEP, filteredItems.length))}
                >
                  Show more
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
