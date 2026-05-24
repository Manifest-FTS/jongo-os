"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  initialEnabled: boolean;
  hasDetectedStaging: boolean;
};

type PendingAction = "enable" | "disable" | null;

type StagingToggleResponse = {
  error?: string;
  message?: string;
  actionHint?: string | null;
  manualProvisionRequired?: boolean;
};

export default function SiteStagingToggle({ siteId, initialEnabled, hasDetectedStaging }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionHint, setActionHint] = useState<string | null>(null);
  const [manualProvisionRequired, setManualProvisionRequired] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [burnOnDisable, setBurnOnDisable] = useState(false);

  async function submitToggle(nextEnabled: boolean, burnExisting: boolean) {
    if (loading) {
      return;
    }

    setError(null);
    setMessage(null);
    setActionHint(null);
    setManualProvisionRequired(false);

    setLoading(true);

    try {
      const response = await fetch(`/api/sites/${siteId}/staging`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: nextEnabled,
          burnExisting
        })
      });

      const payload = (await response.json()) as StagingToggleResponse;
      if (!response.ok) {
        setError(payload?.error ?? "Unable to update staging state.");
        return;
      }

      setEnabled(nextEnabled);
      setPendingAction(null);
      setBurnOnDisable(false);
      setMessage(payload?.message ?? (nextEnabled ? "Staging enabled." : "Staging disabled."));
      setActionHint(payload?.actionHint ?? null);
      setManualProvisionRequired(Boolean(payload?.manualProvisionRequired));
      router.refresh();
    } catch {
      setError("Network error while updating staging.");
    } finally {
      setLoading(false);
    }
  }

  function requestToggle() {
    if (loading) {
      return;
    }
    setError(null);
    setMessage(null);
    setActionHint(null);
    setManualProvisionRequired(false);
    setBurnOnDisable(false);
    setPendingAction(enabled ? "disable" : "enable");
  }

  function cancelPendingAction() {
    if (loading) {
      return;
    }
    setPendingAction(null);
    setBurnOnDisable(false);
  }

  const isDisableAction = pendingAction === "disable";
  const isEnableAction = pendingAction === "enable";

  return (
    <div style={{ display: "grid", gap: "0.55rem", justifyItems: "end", minWidth: "260px" }}>
      <button
        type="button"
        onClick={requestToggle}
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

      {pendingAction ? (
        <div
          style={{
            width: "100%",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            background: "var(--surface-alt)",
            padding: "0.75rem"
          }}
        >
          <p style={{ margin: 0, fontSize: "0.86rem", fontWeight: 600 }}>
            {isEnableAction ? "Confirm enabling staging" : "Confirm disabling staging"}
          </p>
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
            {isEnableAction
              ? "Jongo will try to provision staging in Coolify and use a staging.<production-domain> URL when possible."
              : "Disable staging in Jongo. Existing staging stays in Coolify unless you also choose to destroy it."}
          </p>

          {isDisableAction && hasDetectedStaging ? (
            <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginTop: "0.6rem", fontSize: "0.8rem" }}>
              <input
                type="checkbox"
                checked={burnOnDisable}
                onChange={(event) => setBurnOnDisable(event.target.checked)}
                disabled={loading}
              />
              Also destroy the existing staging app in Coolify (destructive)
            </label>
          ) : null}

          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.7rem" }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={cancelPendingAction}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              onClick={() => submitToggle(isEnableAction, isDisableAction ? burnOnDisable : false)}
              disabled={loading}
            >
              {isEnableAction ? "Confirm enable" : "Confirm disable"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="form-error" style={{ margin: 0 }}>{error}</p> : null}
      {message ? <p className="form-success" style={{ margin: 0 }}>{message}</p> : null}
      {manualProvisionRequired ? (
        <p style={{ margin: 0, fontSize: "0.82rem", color: "#a15c00" }}>
          {actionHint ?? "Manual provisioning in Coolify is required before staging will be detected."}
        </p>
      ) : null}
    </div>
  );
}
