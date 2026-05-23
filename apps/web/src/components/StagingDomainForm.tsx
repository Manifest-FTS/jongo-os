"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  initialDomains: string;
};

export default function StagingDomainForm({ siteId, initialDomains }: Props) {
  const router = useRouter();
  const [domains, setDomains] = useState(initialDomains);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) {
      return;
    }

    setError(null);
    setMessage(null);

    const trimmed = domains.trim();
    if (!trimmed) {
      setError("Enter at least one domain.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`/api/sites/${siteId}/staging`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: trimmed })
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error ?? payload?.message ?? "Unable to update staging domains.");
        return;
      }

      setMessage(payload?.message ?? "Staging domains updated.");
      router.refresh();
    } catch {
      setError("Network error while updating staging domains.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="form-stack" style={{ marginTop: "0.75rem" }}>
      <div>
        <label className="form-label">Staging Domains</label>
        <input
          type="text"
          className="form-input"
          value={domains}
          onChange={(event) => {
            setDomains(event.target.value);
            setError(null);
            setMessage(null);
          }}
          placeholder="staging.example.com, staging-alt.example.com"
          disabled={loading}
        />
        <p className="card-muted" style={{ margin: "0.4rem 0 0", fontSize: "0.8rem" }}>
          Use comma-separated domains. Jongo syncs this field to Coolify.
        </p>
      </div>

      {error ? <p className="form-error" style={{ margin: 0 }}>{error}</p> : null}
      {message ? <p className="form-success" style={{ margin: 0 }}>{message}</p> : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className="btn" disabled={loading}>
          {loading ? "Updating..." : "Save Staging Domains"}
        </button>
      </div>
    </form>
  );
}
