"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { ClientBillingDto } from "@/lib/client-billing";
import ActiveClientPicker from "./ActiveClientPicker";

type Domain = {
  id: string; name: string; organizationId: string | null; client: { id: string; name: string } | null;
  expiresAt: string | null; autoRenew: boolean; dnsStatus: string | null; nameservers: string[];
  financial?: { isBillable: boolean; billingOverride: boolean; clientBilling: ClientBillingDto | null };
};

function MappingForm({ domain, onSaved }: { domain: Domain; onSaved: () => void }) {
  const [clientId, setClientId] = useState(domain.organizationId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/managed-domains", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ domainId: domain.id, organizationId: clientId || null,
          ...(clientId ? { isBillable: fields.get("isBillable") === "on", billingOverride: fields.get("billingOverride") === "on" } : {}) })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Mapping could not be saved.");
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Mapping could not be saved."); }
    finally { setBusy(false); }
  }
  return <article className="card"><form className="form-stack" onSubmit={submit}>
    <h2 className="card-title">Client mapping — {domain.name}</h2>
    <ActiveClientPicker value={clientId} onChange={setClientId} disabled={busy} />
    <label className="form-label"><input type="checkbox" name="isBillable" defaultChecked={domain.financial?.isBillable} disabled={busy || !clientId} /> Billable domain</label>
    <label className="form-label"><input type="checkbox" name="billingOverride" defaultChecked={domain.financial?.billingOverride} disabled={busy || !clientId} /> Manual domain billing override flag</label>
    <p className="card-muted">Flags are bookkeeping only; they do not change registrar auto-renew or charge a card. Map to an active client before changing flags. Client payment status and notes are managed separately.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save mapping and flags"}</button>
  </form></article>;
}

export default function ManagedDomainsView({ superAdmin, initialUnassigned }: { superAdmin: boolean; initialUnassigned: boolean }) {
  const [assignment, setAssignment] = useState(initialUnassigned ? "unassigned" : "all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Domain | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setDomains([]); setSelected(null); setCanManage(false);
    const timer = setTimeout(() => {
      fetch(`/api/managed-domains?${new URLSearchParams({ assignment, q, page: String(page), pageSize: "50" })}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Access denied."); return payload; })
        .then((payload) => { setDomains(payload.domains); setHasMore(payload.hasMore); setCanManage(payload.canManageBilling); })
        .catch((cause) => { if (!controller.signal.aborted) setError(cause.message || "Unable to load domains."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [assignment, q, page, revision]);

  return <>
    <article className="card">
      <div className="form-row">
        <label className="form-label">Search domains<input className="form-input" type="search" value={q} maxLength={253} onChange={(event) => { setQ(event.target.value); setPage(1); }} /></label>
        <label className="form-label">Client mapping<select className="form-input" value={assignment} onChange={(event) => { setAssignment(event.target.value); setPage(1); }}>
          <option value="all">All visible domains</option><option value="assigned">Assigned</option>
          {superAdmin ? <option value="unassigned">Unassigned — needs client mapping</option> : null}
        </select></label>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading ? <p className="card-muted" role="status">Loading managed inventory…</p> : null}
      {!loading && !error && !domains.length ? <p className="card-muted">No domains match this view.</p> : null}
      <div className="overflow-x-auto" aria-busy={loading}>
        <table className="w-full text-[0.88rem]">
          <thead><tr className="text-left text-muted">{["Domain", "Client", "Expiry", "Auto renew", "DNS", ...(canManage ? ["Client billing", "Mapping / flags"] : [])].map((title) => <th scope="col" className="py-2 pr-3" key={title}>{title}</th>)}</tr></thead>
          <tbody>{domains.map((domain) => <tr className="border-0 border-t border-solid border-border" key={domain.id}>
            <td className="py-3 pr-3"><Link className="action-link font-semibold" href={`/my-domains/${encodeURIComponent(domain.id)}`}>{domain.name}</Link></td>
            <td className="py-3 pr-3">{domain.client?.name ?? "Unassigned"}</td>
            <td className="py-3 pr-3 whitespace-nowrap">{domain.expiresAt ? new Date(domain.expiresAt).toLocaleDateString() : "Unknown"}</td>
            <td className="py-3 pr-3">{domain.autoRenew ? "On" : "Off"}</td>
            <td className="py-3 pr-3"><span className="status-chip">{domain.dnsStatus ?? "Unknown"}</span><div className="text-muted text-[0.78rem]">{domain.nameservers.join(", ")}</div></td>
            {canManage ? <>
              <td className="py-3 pr-3">{domain.client ? <Link className="action-link" href={`/client-billing?clientId=${encodeURIComponent(domain.client.id)}`}>{domain.financial?.clientBilling?.billingStatus?.replaceAll("_", " ") ?? "Unknown — unsupported"}</Link> : "Map client first"}</td>
              <td className="py-3 pr-3"><button className="btn btn-secondary" onClick={() => setSelected(domain)}>Edit<span className="sr-only"> mapping and flags for {domain.name}</span></button>
                <div className="text-muted text-[0.78rem]">{domain.financial?.isBillable ? "Billable" : "Not billable"}{domain.financial?.billingOverride ? " · Override" : ""}</div></td>
            </> : null}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="form-row mt-4">
        <button className="btn btn-secondary" disabled={loading || page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button><span>Page {page}</span>
        <button className="btn btn-secondary" disabled={loading || !hasMore} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </article>
    {canManage && selected ? <MappingForm key={selected.id} domain={selected} onSaved={() => { setSelected(null); setMessage("Mapping and flags saved."); setRevision((r) => r + 1); }} /> : null}
  </>;
}