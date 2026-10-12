"use client";

import { useCallback, useEffect, useState } from "react";
import { cx } from "@/lib/public-ui";

type Domain = {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
  cnameTarget: string;
  lastError: string | null;
  lastErrorReason: string | null;
  lastCheckedAt: string | null;
  isPrimary: boolean;
};

type View = { canManage: boolean; fallbackHost: string; primaryHost: string; max: number; domains: Domain[] };

const STATUS: Record<string, { label: string; tone: string }> = {
  pending_dns: { label: "Waiting for DNS", tone: "unknown" },
  verified: { label: "Attaching", tone: "degraded" },
  active: { label: "Connected", tone: "healthy" },
  dns_lost: { label: "DNS changed", tone: "error" },
  failed: { label: "Failed", tone: "error" }
};

const SSL: Record<string, { label: string; tone: string }> = {
  pending: { label: "SSL issuing", tone: "degraded" },
  issued: { label: "SSL active", tone: "healthy" },
  failed: { label: "SSL failed", tone: "error" }
};

function Chip({ label, tone }: { label: string; tone: string }) {
  return <span className={`status-chip ${tone}`}>{label}</span>;
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="ml-2 px-2 py-0.5 rounded-md border border-solid border-border bg-white text-[11.5px] font-semibold text-leaf-ink cursor-pointer hover:border-border-strong"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** "staging.clientsite.com" -> "staging" (what most DNS panels want as the Name). */
function relativeName(hostname: string): string {
  const parts = hostname.split(".");
  return parts.length > 2 ? parts.slice(0, parts.length - 2).join(".") : hostname;
}

/**
 * Custom staging domains, step by step: add the hostname, create the CNAME
 * shown, Verify. Replaces the old free-text field, which sent whatever was
 * typed straight to Coolify with no DNS check and no SSL status.
 */
export default function StagingDomainsPanel({ siteId }: { siteId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/sites/${siteId}/staging/domains`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (payload?.ok) {
      setView(payload as View);
      setLoadError(null);
    } else {
      setLoadError(payload?.message ?? "Could not load staging domains.");
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, request: () => Promise<Response>) {
    setBusy(key);
    setNotice(null);
    try {
      const response = await request();
      const payload = await response.json().catch(() => null);
      setNotice({ tone: payload?.ok ? "ok" : "warn", text: payload?.message ?? `Request failed (HTTP ${response.status}).` });
      if (payload?.ok && key === "add") setHostname("");
      await load();
    } catch {
      setNotice({ tone: "warn", text: "Lost the connection. Try again." });
    } finally {
      setBusy(null);
    }
  }

  if (loadError) return <p className="m-0 mt-3 text-[13px] text-muted">{loadError}</p>;
  if (!view) return <p className="m-0 mt-3 text-[13px] text-muted">Loading staging domains…</p>;

  const canAdd = view.canManage && view.domains.length < view.max;

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="m-0 text-[14px] font-semibold text-ink">Custom staging domain</p>
          <p className="mt-0.5 mb-0 text-[12.5px] text-muted">
            Use your own address, like staging.yoursite.com. <span className="font-mono">{view.fallbackHost}</span> always keeps working.
          </p>
        </div>
        <span className="text-[12px] text-muted">
          Staging link: <a href={`https://${view.primaryHost}`} target="_blank" rel="noopener noreferrer" className="action-link font-semibold">{view.primaryHost}</a>
        </span>
      </div>

      {view.domains.map((domain) => {
        const status = STATUS[domain.status] ?? { label: domain.status, tone: "unknown" };
        const ssl = SSL[domain.sslStatus];
        const needsDns = domain.status === "pending_dns" || domain.status === "dns_lost";
        return (
          <div key={domain.id} className="rounded-xl border border-solid border-border bg-white px-4 py-3.5">
            <div className="flex items-center gap-2 flex-wrap">
              <a href={`https://${domain.hostname}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-ink text-[14.5px] mr-1 break-all">
                {domain.hostname}
              </a>
              <Chip {...status} />
              {ssl ? <Chip {...ssl} /> : null}
              {domain.isPrimary ? <Chip label="Staging link" tone="healthy" /> : null}
              {view.canManage ? (
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary px-3 py-1.5 text-[12.5px]"
                    disabled={busy !== null}
                    onClick={() => act(`verify-${domain.id}`, () => fetch(`/api/sites/${siteId}/staging/domains/${domain.id}/verify`, { method: "POST" }))}
                  >
                    {busy === `verify-${domain.id}` ? "Checking…" : domain.status === "pending_dns" ? "Verify" : "Check again"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger px-3 py-1.5 text-[12.5px]"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm(`Remove ${domain.hostname}? Staging goes back to ${view.fallbackHost}.`)) return;
                      void act(`remove-${domain.id}`, () => fetch(`/api/sites/${siteId}/staging/domains/${domain.id}`, { method: "DELETE" }));
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </div>

            {needsDns ? (
              <div className="mt-3 rounded-lg border border-solid border-border bg-bg px-3.5 py-3">
                <p className="m-0 text-[12.5px] font-semibold text-leaf-ink">
                  {domain.status === "dns_lost" ? "This record changed. Put it back:" : "Create this record where your domain's DNS is managed:"}
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="text-[12.5px] min-w-[420px]">
                    <thead>
                      <tr className="text-left text-muted">
                        <th className="pr-5 py-1 font-semibold">Type</th>
                        <th className="pr-5 py-1 font-semibold">Name</th>
                        <th className="pr-5 py-1 font-semibold">Value</th>
                        <th className="py-1 font-semibold">Proxy</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="font-mono text-ink">
                        <td className="pr-5 py-1">CNAME</td>
                        <td className="pr-5 py-1 whitespace-nowrap">
                          {relativeName(domain.hostname)}
                          <CopyValue value={relativeName(domain.hostname)} />
                        </td>
                        <td className="pr-5 py-1 whitespace-nowrap">
                          {domain.cnameTarget}
                          <CopyValue value={domain.cnameTarget} />
                        </td>
                        <td className="py-1 font-sans">DNS only (grey cloud)</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 mb-0 text-[11.5px] text-muted">
                  Some DNS hosts want the full name, {domain.hostname}. If yours can&apos;t make a CNAME, use an A record to the same IP as {domain.cnameTarget}.
                </p>
              </div>
            ) : null}

            {domain.lastError ? (
              <p className={cx("mt-2.5 mb-0 text-[12.5px]", domain.status === "active" && domain.sslStatus !== "failed" ? "text-muted" : "text-warn-text")}>
                {domain.lastError}
              </p>
            ) : null}
          </div>
        );
      })}

      {canAdd ? (
        <form
          className="flex gap-2 flex-wrap"
          onSubmit={(event) => {
            event.preventDefault();
            if (!hostname.trim()) return;
            void act("add", () =>
              fetch(`/api/sites/${siteId}/staging/domains`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ hostname })
              })
            );
          }}
        >
          <input
            className="form-input flex-1 min-w-[220px]"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="staging.yoursite.com"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="Custom staging domain"
          />
          <button type="submit" className="btn" disabled={busy !== null || !hostname.trim()}>
            {busy === "add" ? "Adding…" : "Add domain"}
          </button>
        </form>
      ) : view.canManage ? (
        <p className="m-0 text-[12px] text-muted">A site can have up to {view.max} custom staging domains.</p>
      ) : null}

      {notice ? (
        <p className={cx("m-0 px-3 py-2 rounded-lg text-[12.5px] border border-solid", notice.tone === "ok" ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text")}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
