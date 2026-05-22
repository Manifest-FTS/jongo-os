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
    <div style={{ display: "grid", gap: "0.55rem", justifyItems: "end" }}>
      <button
        type="button"
        onClick={() => handleToggle(!enabled)}
        aria-label={`Turn staging ${enabled ? "off" : "on"}`}
        aria-pressed={enabled}
        disabled={loading}
        style={{
          width: "58px",
          height: "32px",
          borderRadius: "999px",
          border: `1px solid ${enabled ? "var(--accent)" : "var(--border)"}`,
          background: enabled ? "var(--accent)" : "var(--surface-alt)",
          position: "relative",
          cursor: loading ? "not-allowed" : "pointer",
          transition: "background 0.2s ease, border-color 0.2s ease"
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: "3px",
            left: enabled ? "30px" : "3px",
            width: "24px",
            height: "24px",
            borderRadius: "999px",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 0.2s ease"
          }}
        />
      </button>

      <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
        {loading ? "Updating..." : enabled ? "On" : "Off"}
      </p>

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
