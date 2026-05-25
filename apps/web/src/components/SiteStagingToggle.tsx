"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  initialEnabled: boolean;
  hasDetectedStaging: boolean;
};

type PendingAction = "enable" | "disable" | null;
type ModalMode = "confirm" | "result";

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
  const [burnOnDisable, setBurnOnDisable] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>("confirm");

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
        setModalMode("result");
        setModalOpen(true);
        return;
      }

      setEnabled(nextEnabled);
      setPendingAction(null);
      setBurnOnDisable(true);
      setMessage(payload?.message ?? (nextEnabled ? "Staging enabled." : "Staging disabled."));
      setActionHint(payload?.actionHint ?? null);
      setManualProvisionRequired(Boolean(payload?.manualProvisionRequired));
      setModalMode("result");
      setModalOpen(true);
      router.refresh();
    } catch {
      setError("Network error while updating staging.");
      setModalMode("result");
      setModalOpen(true);
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
    setBurnOnDisable(enabled);
    setPendingAction(enabled ? "disable" : "enable");
    setModalMode("confirm");
    setModalOpen(true);
  }

  function cancelPendingAction() {
    if (loading) {
      return;
    }
    setPendingAction(null);
    setBurnOnDisable(true);
    setModalOpen(false);
    setModalMode("confirm");
  }

  function closeResultModal() {
    if (loading) {
      return;
    }
    setModalOpen(false);
    setModalMode("confirm");
    setError(null);
    setMessage(null);
    setActionHint(null);
    setManualProvisionRequired(false);
  }

  const isDisableAction = pendingAction === "disable";
  const isEnableAction = pendingAction === "enable";
  const waitingForManualStagingSetup = enabled && !hasDetectedStaging;
  const showResultBody = modalMode === "result" || Boolean(error || message || actionHint || waitingForManualStagingSetup);

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

      {modalOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 120,
            background: "rgba(8, 12, 20, 0.55)",
            display: "grid",
            placeItems: "center",
            padding: "1rem"
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={modalMode === "confirm" ? "Confirm staging change" : "Staging update result"}
            style={{
              width: "100%",
              maxWidth: "520px",
              borderRadius: "14px",
              border: "1px solid var(--border)",
              background: "linear-gradient(180deg, var(--surface-alt), var(--surface))",
              boxShadow: "0 22px 60px rgba(6, 10, 22, 0.38)",
              padding: "1rem"
            }}
          >
            <p style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700 }}>
              {modalMode === "confirm"
                ? (isEnableAction ? "Enable staging" : "Disable staging")
                : "Staging update"}
            </p>

            {modalMode === "confirm" ? (
              <>
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                  {isEnableAction
                    ? "Jongo will try to provision staging in Coolify and use a staging.<production-domain> URL when possible."
                    : "Disable staging in Jongo. By default, existing staging resources in Coolify are removed."}
                </p>

                {isDisableAction && hasDetectedStaging ? (
                  <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginTop: "0.8rem", fontSize: "0.82rem" }}>
                    <input
                      type="checkbox"
                      checked={burnOnDisable}
                      onChange={(event) => setBurnOnDisable(event.target.checked)}
                      disabled={loading}
                    />
                    Remove existing staging resources in Coolify (destructive)
                  </label>
                ) : null}

                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1rem" }}>
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
                    {isEnableAction ? "Accept and enable" : "Accept and disable"}
                  </button>
                </div>
              </>
            ) : null}

            {showResultBody && modalMode === "result" ? (
              <>
                {error ? <p className="form-error" style={{ margin: "0.6rem 0 0" }}>{error}</p> : null}
                {message ? (
                  <p
                    className={manualProvisionRequired ? undefined : "form-success"}
                    style={manualProvisionRequired ? { margin: "0.6rem 0 0", fontSize: "0.84rem", color: "#a15c00" } : { margin: "0.6rem 0 0" }}
                  >
                    {message}
                  </p>
                ) : null}
                {manualProvisionRequired ? (
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "#a15c00" }}>
                    {actionHint ?? "Manual provisioning in Coolify is required before staging will be detected."}
                  </p>
                ) : null}
                {waitingForManualStagingSetup && !manualProvisionRequired ? (
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "#a15c00" }}>
                    Staging is enabled in Jongo, but no staging app is detected in Coolify yet. Create or attach staging in Coolify, then refresh.
                  </p>
                ) : null}

                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
                  <button
                    type="button"
                    className="button"
                    onClick={closeResultModal}
                    disabled={loading}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
