"use client";

import { useEffect, useState } from "react";
import type { ClientBillingDto } from "@/lib/client-billing";
import ClientBillingForm from "./ClientBillingForm";

export default function ClientBillingView({ initialClientId }: { initialClientId: string }) {
  const [clients, setClients] = useState<ClientBillingDto[]>([]);
  const [selected, setSelected] = useState<ClientBillingDto | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setClients([]); setSelected(null);
    Promise.all([
      fetch(`/api/client-billing?page=${page}&pageSize=50`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Access denied.");
        return payload;
      }),
      initialClientId ? fetch(`/api/client-billing/${encodeURIComponent(initialClientId)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Client not available.");
        return payload.client as ClientBillingDto;
      }) : Promise.resolve(null)
    ]).then(([payload, client]) => {
      setClients(payload.clients); setHasMore(payload.hasMore); setSelected(client);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause.message || "Unable to load billing."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, initialClientId]);

  return (
    <>
      <article className="card" aria-busy={loading}>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {loading ? <p className="card-muted" role="status">Loading client bookkeeping…</p> : null}
        {!loading && !error && !clients.length ? <p className="card-muted">No active clients.</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-[0.88rem]">
            <thead><tr className="text-left text-muted">{["Client", "Mode", "Effective status", "Override"].map((title) => <th className="py-2 pr-3" key={title} scope="col">{title}</th>)}</tr></thead>
            <tbody>{clients.map((client) => <tr className="border-0 border-t border-solid border-border" key={client.id}>
              <td className="py-3 pr-3 font-semibold">{client.name}</td>
              <td className="py-3 pr-3">{client.billingMode.replaceAll("_", " ")}</td>
              <td className="py-3 pr-3">{client.supported ? client.billingStatus?.replaceAll("_", " ") : "Unknown — unsupported"}</td>
              <td className="py-3 pr-3"><button className="btn btn-secondary" onClick={() => setSelected(client)}>Manage billing<span className="sr-only"> for {client.name}</span></button></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="form-row mt-4">
          <button className="btn btn-secondary" disabled={page === 1 || loading} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <span>Page {page}</span>
          <button className="btn btn-secondary" disabled={!hasMore || loading} onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
      </article>
      {selected ? <article className="card"><ClientBillingForm key={selected.id} client={selected} onSaved={(client) => {
        setSelected(client); setClients((rows) => rows.map((row) => row.id === client.id ? client : row));
      }} /></article> : null}
    </>
  );
}