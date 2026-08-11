"use client";

import { useEffect, useState } from "react";

/**
 * The right-hand column: what the staging site actually is.
 *
 * Fetched live rather than read from the backup catalogue, which knows the
 * WordPress version as of the last backup — exactly wrong for a panel someone
 * opens to check whether an upgrade landed.
 *
 * Loaded client-side and after paint, deliberately: it SSHes to the host and
 * execs into a container, far too slow to block the page on. Staging actions
 * are what people come here for; these facts are reference.
 */

type Facts = {
  ok?: boolean;
  message?: string;
  wpVersion?: string | null;
  phpVersion?: string | null;
  databaseName?: string | null;
  tablePrefix?: string | null;
};

function FactRow({ label, value }: { label: string; value?: string | null }) {
  const missing = !value || !String(value).trim();
  return (
    <div className="facts-row">
      <span className="facts-row__label">{label}</span>
      <span className={`facts-row__value${missing ? " facts-row__value--empty" : ""}`}>
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

  const unavailable = (
    <p className="card-muted panel-subheading">{facts?.message ?? "Details are unavailable."}</p>
  );
  const pending = <p className="card-muted panel-subheading">Reading staging container…</p>;

  return (
    <div className="stack">
      <article className="card">
        <h3 className="panel-heading">Domain</h3>
        {stagingUrl ? (
          <p className="panel-subheading">
            <a href={`https://${stagingUrl}`} target="_blank" rel="noreferrer" className="action-link">
              {stagingUrl.replace(/^https?:\/\//, "")}
            </a>
          </p>
        ) : (
          <p className="panel-subheading">No staging domain assigned yet.</p>
        )}
      </article>

      <article className="card">
        <h3 className="panel-heading">Runtime</h3>
        {loading ? pending : facts?.ok ? (
          <div className="stack--tight">
            <FactRow label="WordPress" value={facts.wpVersion} />
            <FactRow label="PHP" value={facts.phpVersion} />
          </div>
        ) : unavailable}
      </article>

      <article className="card">
        <h3 className="panel-heading">Database</h3>
        {loading ? pending : facts?.ok ? (
          <div className="stack--tight">
            <FactRow label="Name" value={facts.databaseName} />
            <FactRow label="Prefix" value={facts.tablePrefix} />
          </div>
        ) : unavailable}
      </article>
    </div>
  );
}
