"use client";

import { useState } from "react";

type SyncResult = {
  ok: boolean;
  updatedSites: number;
  backfilledOrganizations: number;
  orphanedCount: number;
};

export default function OwnershipSyncPanel() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  async function runSync() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/coolify/ownership/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Ownership sync failed");
        return;
      }

      setResult(data as SyncResult);
    } catch {
      setError("Network error while syncing ownership mappings.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="card tone-card">
      <h3 className="card-title">Coolify Ownership Sync</h3>
      <p className="card-muted">
        Sync Coolify Project ownership into Jongo Client mappings for imported resources.
      </p>
      <button type="button" className="btn" onClick={runSync} disabled={loading}>
        {loading ? "Syncing..." : "Run Ownership Sync"}
      </button>

      {error && <p className="form-error" style={{ marginTop: "0.75rem" }}>{error}</p>}

      {result && (
        <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.35rem", fontSize: "0.9rem" }}>
          <p style={{ margin: 0 }}>Sites updated: <strong>{result.updatedSites}</strong></p>
          <p style={{ margin: 0 }}>Organizations backfilled: <strong>{result.backfilledOrganizations}</strong></p>
          <p style={{ margin: 0 }}>Orphaned resources: <strong>{result.orphanedCount}</strong></p>
        </div>
      )}
    </article>
  );
}
