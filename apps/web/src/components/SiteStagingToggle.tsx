"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  initialEnabled: boolean;
  hasDetectedStaging: boolean;
};

export default function SiteStagingToggle({ siteId, initialEnabled, hasDetectedStaging }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleToggle(nextEnabled: boolean) {
    if (loading) {
      return;
    }

    setError(null);
    setMessage(null);

    if (!nextEnabled && hasDetectedStaging) {
      const confirmed = window.confirm(
        "Disable staging and burn the existing staging environment in Coolify? This deletes the staging app."
      );
      if (!confirmed) {
        return;
      }
    }

    setLoading(true);

    try {
      const response = await fetch(`/api/sites/${siteId}/staging`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: nextEnabled,
          burnExisting: !nextEnabled
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error ?? "Unable to update staging state.");
        return;
      }

      setEnabled(nextEnabled);
      setMessage(payload?.message ?? (nextEnabled ? "Staging enabled." : "Staging disabled."));
      router.refresh();
    } catch {
      setError("Network error while updating staging.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.6rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <p style={{ margin: 0, fontWeight: 600, fontSize: "0.95rem" }}>
            Staging {enabled ? "Enabled" : "Disabled"}
          </p>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted)", fontSize: "0.84rem" }}>
            {enabled
              ? "Staging should be created from current production and used for validation before promotion."
              : "Turn this on to create/detect staging from the current production application."}
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => handleToggle(!enabled)}
          disabled={loading}
          style={{ minWidth: "146px" }}
        >
          {loading ? "Updating..." : enabled ? "Disable Staging" : "Enable Staging"}
        </button>
      </div>

      {enabled && hasDetectedStaging ? (
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--warning, #d97706)" }}>
          Disabling staging will warn first and attempt to burn the existing staging environment.
        </p>
      ) : null}

      {error ? <p className="form-error" style={{ margin: 0 }}>{error}</p> : null}
      {message ? <p className="form-success" style={{ margin: 0 }}>{message}</p> : null}
    </div>
  );
}
