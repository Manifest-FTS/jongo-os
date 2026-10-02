"use client";

import { useCallback, useEffect, useState } from "react";
import { DNS_RECORD_TYPES, PROXIABLE_TYPES, shortRecordName, type DnsRecordType } from "@/lib/dns-record";

type Record_ = { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean; priority?: number };

type Draft = { type: DnsRecordType; name: string; content: string; ttl: number; proxied: boolean; priority: number };

const EMPTY: Draft = { type: "A", name: "@", content: "", ttl: 1, proxied: true, priority: 10 };

/**
 * DNS records for a domain, served by its Cloudflare zone. Reading is open to
 * the client's members; changing needs a client admin (checked again by the API).
 */
export default function DnsRecordsPanel({
  domainId,
  zoneName,
  canManage,
  zoneReady
}: {
  domainId: string;
  zoneName: string;
  canManage: boolean;
  zoneReady: boolean;
}) {
  const [records, setRecords] = useState<Record_[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/domains/${domainId}/dns`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (payload?.ok) {
      setRecords(payload.records);
      setLoadError(null);
    } else {
      setLoadError(payload?.message ?? "Could not load DNS records.");
    }
  }, [domainId]);

  useEffect(() => {
    if (zoneReady) void load();
  }, [zoneReady, load]);

  function startEdit(record: Record_) {
    setEditingId(record.id);
    setErrors({});
    setDraft({
      type: (DNS_RECORD_TYPES as readonly string[]).includes(record.type) ? (record.type as DnsRecordType) : "A",
      name: shortRecordName(record.name, zoneName),
      content: record.content,
      ttl: record.ttl,
      proxied: record.proxied,
      priority: record.priority ?? 10
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    const url = editingId ? `/api/domains/${domainId}/dns/${editingId}` : `/api/domains/${domainId}/dns`;
    const response = await fetch(url, {
      method: editingId ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft)
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(false);
    if (payload?.ok) {
      setDraft(EMPTY);
      setEditingId(null);
      setMessage(editingId ? "Record updated." : "Record added.");
      await load();
    } else {
      setErrors(payload?.fieldErrors ?? {});
      setMessage(payload?.message ?? "Could not save the record.");
    }
  }

  async function remove(record: Record_) {
    if (!window.confirm(`Delete the ${record.type} record for ${record.name}? Anything using it stops working.`)) return;
    setBusy(true);
    const response = await fetch(`/api/domains/${domainId}/dns/${record.id}`, { method: "DELETE" }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(false);
    setMessage(payload?.ok ? "Record deleted." : payload?.message ?? "Could not delete the record.");
    await load();
  }

  const proxiable = PROXIABLE_TYPES.includes(draft.type);
  const err = (key: string) => (errors[key] ? <span className="form-error text-[0.76rem]">{errors[key]}</span> : null);

  return (
    <article className="card">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="card-title m-0">DNS records</h3>
        <p className="card-muted m-0 text-[0.8rem]">Served by Cloudflare · SSL covers {zoneName} and *.{zoneName}</p>
      </div>

      {!zoneReady ? (
        <p className="card-muted mt-2 mb-0">DNS is set up automatically once the domain is registered. Check back in a few minutes.</p>
      ) : loadError ? (
        <p className="form-error mt-2 mb-0">{loadError}</p>
      ) : records === null ? (
        <p className="card-muted mt-2 mb-0">Loading…</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[0.85rem]">
            <thead>
              <tr className="text-left text-muted">
                <th className="font-semibold py-2 pr-3">Type</th>
                <th className="font-semibold py-2 pr-3">Name</th>
                <th className="font-semibold py-2 pr-3">Content</th>
                <th className="font-semibold py-2 pr-3">TTL</th>
                <th className="font-semibold py-2 pr-3">Proxy</th>
                {canManage ? <th className="py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-3 text-muted">
                    No records yet. Add an A record for @ pointing at your server to put a site on this domain.
                  </td>
                </tr>
              ) : (
                records.map((record) => (
                  <tr key={record.id} className="border-0 border-t border-solid border-border align-top">
                    <td className="py-2 pr-3 font-semibold">{record.type}</td>
                    <td className="py-2 pr-3">{shortRecordName(record.name, zoneName)}</td>
                    <td className="py-2 pr-3 font-mono text-[0.8rem] break-all">
                      {record.priority !== undefined && record.type === "MX" ? `${record.priority} ` : ""}
                      {record.content}
                    </td>
                    <td className="py-2 pr-3">{record.ttl === 1 ? "Auto" : `${record.ttl}s`}</td>
                    <td className="py-2 pr-3">{record.proxied ? "On" : "Off"}</td>
                    {canManage ? (
                      <td className="py-2 whitespace-nowrap text-right">
                        <button type="button" className="btn btn-secondary px-2.5 py-1 text-[0.78rem]" onClick={() => startEdit(record)} disabled={busy}>
                          Edit
                        </button>{" "}
                        <button type="button" className="btn btn-danger px-2.5 py-1 text-[0.78rem]" onClick={() => remove(record)} disabled={busy}>
                          Delete
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {zoneReady && canManage ? (
        <form onSubmit={save} className="mt-4 pt-4 border-0 border-t border-solid border-border grid gap-3">
          <p className="m-0 font-semibold text-[0.9rem]">{editingId ? "Edit record" : "Add a record"}</p>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-[110px_1fr_2fr_110px]">
            <label className="grid gap-1">
              <span className="form-label">Type</span>
              <select
                className="form-input"
                value={draft.type}
                onChange={(e) => {
                  const type = e.target.value as DnsRecordType;
                  setDraft((d) => ({ ...d, type, proxied: PROXIABLE_TYPES.includes(type) ? d.proxied : false }));
                }}
              >
                {DNS_RECORD_TYPES.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="form-label">Name</span>
              <input className="form-input" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="@ or www" />
              {err("name")}
            </label>
            <label className="grid gap-1 col-span-2 sm:col-span-1">
              <span className="form-label">Content</span>
              <input className="form-input" value={draft.content} onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))} placeholder={draft.type === "A" ? "203.0.113.10" : ""} />
              {err("content")}
            </label>
            <label className="grid gap-1">
              <span className="form-label">TTL</span>
              <select className="form-input" value={draft.ttl} onChange={(e) => setDraft((d) => ({ ...d, ttl: Number(e.target.value) }))}>
                <option value={1}>Auto</option>
                <option value={300}>5 min</option>
                <option value={3600}>1 hour</option>
                <option value={86400}>1 day</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {draft.type === "MX" ? (
              <label className="flex items-center gap-2 text-[0.86rem]">
                Priority
                <input type="number" className="form-input w-[90px]" value={draft.priority} onChange={(e) => setDraft((d) => ({ ...d, priority: Number(e.target.value) }))} />
              </label>
            ) : null}
            {proxiable ? (
              <label className="flex items-center gap-2 text-[0.86rem]">
                <input type="checkbox" checked={draft.proxied} onChange={(e) => setDraft((d) => ({ ...d, proxied: e.target.checked }))} />
                Proxy through Cloudflare (WAF, DDoS protection, caching)
              </label>
            ) : null}
            <div className="ml-auto flex gap-2">
              {editingId ? (
                <button type="button" className="btn btn-secondary" onClick={() => { setEditingId(null); setDraft(EMPTY); setErrors({}); }}>
                  Cancel
                </button>
              ) : null}
              <button type="submit" className="btn" disabled={busy || !draft.content.trim()}>
                {busy ? "Saving…" : editingId ? "Save record" : "Add record"}
              </button>
            </div>
          </div>
          {message ? <p className="m-0 text-[0.84rem] text-muted">{message}</p> : null}
        </form>
      ) : message ? (
        <p className="mt-3 mb-0 text-[0.84rem] text-muted">{message}</p>
      ) : null}
    </article>
  );
}
