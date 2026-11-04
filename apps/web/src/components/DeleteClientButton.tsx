"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  organizationId: string;
};

/**
 * Deletes a client after an inline confirmation. A client that still has apps
 * can't be deleted (their hosting would keep running with no one able to see
 * it), and the server says so plainly; that message is shown here.
 */
export default function DeleteClientButton({ organizationId }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(organizationId)}`, { method: "DELETE" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(typeof data?.error === "string" ? data.error : "This client couldn't be deleted right now. Try again shortly.");
        setConfirming(false);
        return;
      }
      router.push("/clients");
      router.refresh();
    } catch {
      setError("Couldn't reach Jongo. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.4rem", justifyItems: "start" }}>
      {confirming ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.85rem" }}>Delete this client? This can't be undone.</span>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={handleDelete}>
            {busy ? "Deleting…" : "Delete client"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => { setError(null); setConfirming(true); }}>
          Delete client
        </button>
      )}
      {error ? <p role="alert" className="auth-error" style={{ margin: 0, fontSize: "0.82rem" }}>{error}</p> : null}
    </div>
  );
}
