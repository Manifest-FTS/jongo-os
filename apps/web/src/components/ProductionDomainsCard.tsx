"use client";

import { useCallback, useEffect, useState } from "react";
import CreationProgress, { applyStep, postWithProgress, type CreationStep } from "@/components/CreationProgress";

type DomainRow = { host: string; primary: boolean; fallback: boolean };
type View = {
  canManage: boolean;
  domains: DomainRow[];
  primary: string | null;
  dnsStatus: string | null;
  dnsMessage: string | null;
  checkedAt: string | null;
};

/**
 * The live site's addresses. One is the main address (WordPress saves it and
 * every link uses it); Jongo's own address stays as a backup that keeps the
 * site reachable if the client's domain lapses.
 */
export default function ProductionDomainsCard({ siteId }: { siteId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyHost, setBusyHost] = useState<string | null>(null);
  const [steps, setSteps] = useState<CreationStep[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [confirmHost, setConfirmHost] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/sites/${siteId}/domains`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response?.ok || !payload?.ok) {
      setLoadError(payload?.message ?? "Addresses couldn't be loaded right now.");
      return;
    }
    setLoadError(null);
    setView(payload as View);
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function makePrimary(host: string) {
    setConfirmHost(null);
    setBusyHost(host);
    setNotice(null);
    setStartedAt(Date.now());
    setSteps([{ id: "read", label: "Reading the site's addresses", status: "active" }]);
    try {
      const result = await postWithProgress(`/api/sites/${siteId}/domains`, { primary: host }, (step) => setSteps((current) => applyStep(current, step)));
      const ok = result.status >= 200 && result.status < 300;
      setSteps((current) => current.map((step) => (step.status === "active" ? { ...step, status: ok ? "done" : "failed" } : step)));
      setNotice({ tone: ok ? "ok" : "warn", text: result.body?.message ?? (ok ? "Done." : "That didn't finish. Try again.") });
      await load();
    } catch {
      setNotice({ tone: "warn", text: "Couldn't reach Jongo. Check your connection and try again." });
    } finally {
      setBusyHost(null);
    }
  }

  if (loadError && !view) {
    return (
      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 className="card-title">Addresses</h3>
        <p className="card-muted" style={{ margin: 0 }}>{loadError}</p>
      </article>
    );
  }
  if (!view) {
    return (
      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 className="card-title">Addresses</h3>
        <p className="card-muted" style={{ margin: 0 }}>Loading addresses…</p>
      </article>
    );
  }

  const fallback = view.domains.find((row) => row.fallback && !row.primary);
  const primaryIsFallback = view.domains.find((row) => row.primary)?.fallback ?? false;
  const hasClientDomain = view.domains.some((row) => !row.fallback);

  return (
    <article className="card" style={{ marginBottom: "1.5rem", display: "grid", gap: "0.8rem" }}>
      <div>
        <h3 className="card-title" style={{ marginBottom: "0.25rem" }}>Addresses</h3>
        <p className="card-muted" style={{ margin: 0 }}>
          The main address is the one WordPress saves and every link uses.
          {fallback ? <> {fallback.host} stays connected as a backup, so the site still opens if the main domain stops working.</> : null}
        </p>
      </div>

      {view.dnsStatus === "dns_lost" && view.dnsMessage ? (
        <p className="m-0 px-3 py-2 rounded-lg text-[12.5px] border border-solid bg-warn-bg border-warn-border text-warn-text">{view.dnsMessage}</p>
      ) : null}
      {primaryIsFallback && hasClientDomain && view.canManage ? (
        <p className="m-0 px-3 py-2 rounded-lg text-[12.5px] border border-solid bg-warn-bg border-warn-border text-warn-text">
          The site&apos;s main address is still Jongo&apos;s backup address. Make your own domain the main address so links and search results use it.
        </p>
      ) : null}

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
        {view.domains.map((row) => (
          <li
            key={row.host}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", padding: "0.6rem 0.75rem", border: "1px solid var(--border)", borderRadius: 10 }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0, flexWrap: "wrap" }}>
              <a className="action-link font-semibold" href={`https://${row.host}`} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: "anywhere" }}>
                {row.host}
              </a>
              {row.primary ? <span className="status-chip healthy">Main address</span> : null}
              {row.fallback && !row.primary ? <span className="status-chip unknown">Backup</span> : null}
              {row.primary && view.dnsStatus === "dns_lost" ? <span className="status-chip error">Not pointing here</span> : null}
            </span>
            {view.canManage && !row.primary ? (
              confirmHost === row.host ? (
                <span style={{ display: "flex", gap: "0.4rem" }}>
                  <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" onClick={() => setConfirmHost(null)}>Cancel</button>
                  <button type="button" className="btn px-3 py-1.5 text-[12.5px]" onClick={() => void makePrimary(row.host)}>Yes, make it main</button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary px-3 py-1.5 text-[12.5px]"
                  disabled={busyHost !== null}
                  onClick={() => setConfirmHost(row.host)}
                >
                  Make main address
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>

      {confirmHost ? (
        <p className="card-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
          WordPress will save {confirmHost} as its address and links on the site will use it. The other addresses keep working. This takes a minute or two.
        </p>
      ) : null}

      {busyHost || (steps.length > 0 && notice) ? (
        <CreationProgress
          title={busyHost ? `Making ${busyHost} the main address` : "Done"}
          steps={steps}
          startedAt={startedAt}
          running={Boolean(busyHost)}
          note={busyHost ? "You can leave this page; the change carries on." : ""}
        />
      ) : null}

      {notice ? (
        <p className={`m-0 px-3 py-2 rounded-lg text-[12.5px] border border-solid ${notice.tone === "ok" ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text"}`}>
          {notice.text}
        </p>
      ) : null}
    </article>
  );
}
