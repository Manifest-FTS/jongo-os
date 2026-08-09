"use client";

import { useEffect, useState } from "react";

/**
 * The right-hand column: what the staging site actually is.
 *
 * Fetched live rather than read from the backup catalogue. The catalogue knows
 * the WordPress version as of the last backup, which is exactly wrong for a
 * panel someone opens to check whether an upgrade landed.
 *
 * Loaded client-side and after paint, deliberately: it SSHes to the host and
 * execs into a container, which is far too slow to block the page on. Staging
 * actions are what people come here for; these facts are reference.
 */

type Facts = {
  ok?: boolean;
  message?: string;
  wpVersion?: string | null;
  phpVersion?: string | null;
  databaseName?: string | null;
  tablePrefix?: string | null;
};

function Row({ label, value }: { label: string; value?: string | null }) {
  const missing = !value || !String(value).trim();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.4rem 0" }}>
      <span className="card-muted" style={{ margin: 0 }}>{label}</span>
      <span
        className={missing ? "card-muted" : "mono-input"}
        style={{ margin: 0, fontWeight: missing ? 400 : 600, background: "none", border: "none", padding: 0 }}
      >
        {/* A blank is honest where a default would not be: a stock image has no
            wp-cli and a stopped database answers nothing. */}
        {missing ? "—" : value}
      </span>
    </div>
  );
}

export default function StagingSiteFacts({
  siteId,
  stagingUrl
}: {
  siteId: string;
  stagingUrl?: string | null;
}) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/sites/${siteId}/wp-info?target=staging`);
        const payload = await response.json().catch(() => null);
        if (!cancelled) setFacts(payload ?? { ok: false, message: "Could not read staging details." });
      } catch {
        if (!cancelled) setFacts({ ok: false, message: "Could not read staging details." });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <article className="card">
        <h3 className="card-title" style={{ marginBottom: "0.5rem" }}>Domain</h3>
        {stagingUrl ? (
          <a href={stagingUrl} target="_blank" rel="noreferrer" className="action-link">
            {stagingUrl.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <p className="card-muted" style={{ margin: 0 }}>No staging domain assigned yet.</p>
        )}
      </article>

      <article className="card">
        <h3 className="card-title" style={{ marginBottom: "0.5rem" }}>Runtime</h3>
        {loading ? (
          <p className="card-muted" style={{ margin: 0 }}>Reading staging container…</p>
        ) : facts?.ok ? (
          <>
            <Row label="WordPress" value={facts.wpVersion} />
            <Row label="PHP" value={facts.phpVersion} />
          </>
        ) : (
          <p className="card-muted" style={{ margin: 0 }}>
            {facts?.message ?? "Runtime details are unavailable."}
          </p>
        )}
      </article>

      <article className="card">
        <h3 className="card-title" style={{ marginBottom: "0.5rem" }}>Database</h3>
        {loading ? (
          <p className="card-muted" style={{ margin: 0 }}>Reading staging container…</p>
        ) : facts?.ok ? (
          <>
            <Row label="Name" value={facts.databaseName} />
            <Row label="Prefix" value={facts.tablePrefix} />
          </>
        ) : (
          <p className="card-muted" style={{ margin: 0 }}>
            {facts?.message ?? "Database details are unavailable."}
          </p>
        )}
      </article>
    </div>
  );
}
