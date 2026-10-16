"use client";

import { useState, type FormEvent } from "react";
import { BILLING_MODES, BILLING_STATUSES, type ClientBillingDto, type BillingMode } from "@/lib/client-billing";

export default function ClientBillingForm({ client, onSaved }: { client: ClientBillingDto; onSaved: (client: ClientBillingDto) => void }) {
  const [mode, setMode] = useState<BillingMode>(client.billingMode);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(`/api/client-billing/${encodeURIComponent(client.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({
          billingMode: mode,
          ...(mode === "manual_override" ? { billingStatus: fields.get("billingStatus") } : {}),
          billingNotes: fields.get("billingNotes") || null,
          bonsaiClientId: fields.get("bonsaiClientId") || null,
          externalInvoiceUrl: fields.get("externalInvoiceUrl") || null
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Billing could not be saved.");
      onSaved(payload.client); setMessage("Client bookkeeping saved. No provider or payment was changed.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Billing could not be saved."); }
    finally { setBusy(false); }
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <h2 className="card-title">{client.name} — billing override</h2>
      <p className="card-muted m-0">{client.message} This does not change the owner&apos;s Jongo account subscription.</p>
      <label className="form-label">Billing mode
        <select className="form-input" name="billingMode" value={mode} onChange={(event) => setMode(event.target.value as BillingMode)} disabled={busy}>
          {BILLING_MODES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
        </select>
      </label>
      {mode === "manual_override" ? (
        <label className="form-label">Manual status (including comped override)
          <select className="form-input" name="billingStatus" defaultValue={client.billingMode === "manual_override" ? client.billingStatus ?? "pending_setup" : "pending_setup"} disabled={busy}>
            {BILLING_STATUSES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
          </select>
        </label>
      ) : <p className="card-muted">{mode === "exempt" ? "Comped is derived from exempt mode; it is never written as a payment." : "Integration not implemented. Payment status will be unknown; no synchronization or external calls occur."}</p>}
      <label className="form-label">Billing notes / reason for manual override
        <textarea className="form-input" name="billingNotes" rows={4} maxLength={4000} defaultValue={client.billingNotes ?? ""} disabled={busy} />
      </label>
      <label className="form-label">Bonsai client ID
        <input className="form-input" name="bonsaiClientId" maxLength={200} pattern="[a-zA-Z0-9_-]+" defaultValue={client.bonsaiClientId ?? ""} disabled={busy} />
      </label>
      <label className="form-label">External invoice link (HTTPS)
        <input className="form-input" name="externalInvoiceUrl" type="url" maxLength={2048} defaultValue={client.externalInvoiceUrl ?? ""} disabled={busy} placeholder="https://…" />
      </label>
      <div className="form-row">
        {client.bonsaiUrl ? <a className="action-link" href={client.bonsaiUrl} target="_blank" rel="noopener noreferrer">Open Bonsai client</a> : null}
        {client.externalInvoiceUrl ? <a className="action-link" href={client.externalInvoiceUrl} target="_blank" rel="noopener noreferrer">Open invoice</a> : null}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save bookkeeping override"}</button>
    </form>
  );
}