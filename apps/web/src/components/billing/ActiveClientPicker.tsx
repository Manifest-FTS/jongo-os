"use client";

import { useEffect, useId, useState } from "react";

export default function ActiveClientPicker({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      fetch(`/api/managed-domains/clients?${new URLSearchParams({ q, page: String(page), pageSize: "50" })}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Unable to load clients."); return payload; })
        .then((payload) => { setClients(payload.clients); setHasMore(payload.hasMore); })
        .catch((cause) => { if (!controller.signal.aborted) { setClients([]); setError(cause.message); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, page]);
  return <div className="form-stack">
    <label className="form-label" htmlFor={`${id}-search`}>Find active client</label>
    <input id={`${id}-search`} className="form-input" type="search" maxLength={200} value={q} disabled={disabled} onChange={(event) => { setQ(event.target.value); setPage(1); }} />
    <label className="form-label" htmlFor={`${id}-client`}>Map to client</label>
    <select id={`${id}-client`} className="form-input" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || loading}>
      <option value="">Unassigned</option>
      {value && !clients.some((client) => client.id === value) ? <option value={value}>Current selection ({value})</option> : null}
      {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
    </select>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="form-row">
      <button className="btn btn-secondary" type="button" disabled={disabled || loading || page === 1} onClick={() => setPage((p) => p - 1)}>Previous clients</button>
      <span>{loading ? "Loading clients…" : `Client page ${page}`}</span>
      <button className="btn btn-secondary" type="button" disabled={disabled || loading || !hasMore} onClick={() => setPage((p) => p + 1)}>More clients</button>
    </div>
  </div>;
}