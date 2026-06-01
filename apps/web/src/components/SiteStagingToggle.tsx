"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  initialEnabled: boolean;
  hasDetectedStagingTarget: boolean;
};

type PendingAction = "enable" | "disable" | null;
type ModalMode = "confirm" | "result";

type StagingToggleResponse = {
  error?: string;
  message?: string;
  actionHint?: string | null;
  manualProvisionRequired?: boolean;
  destroyed?: boolean;
  enableLocked?: boolean;
};

type StagingStatusResponse = {
  stagingEnabled?: boolean;
  stagingConfigured?: boolean;
  stagingCapability?: {
    detected?: boolean;
    applicationUuid?: string;
  };
};

const STAGING_OPERATION_POLL_DELAY_MS = 1500;
const STAGING_OPERATION_MAX_POLLS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function SiteStagingToggle({ siteId, initialEnabled, hasDetectedStagingTarget }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [detectedStagingTarget, setDetectedStagingTarget] = useState(hasDetectedStagingTarget);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionHint, setActionHint] = useState<string | null>(null);
  const [manualProvisionRequired, setManualProvisionRequired] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [burnOnDisable, setBurnOnDisable] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>("confirm");
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeAttempt, setFinalizeAttempt] = useState(0);

  useEffect(() => {
    setDetectedStagingTarget(hasDetectedStagingTarget);
  }, [hasDetectedStagingTarget]);

  async function refreshStagingTargetStatus() {
    try {
      const response = await fetch(`/api/sites/${siteId}/staging`, { method: "GET" });
      if (!response.ok) {
        return;
      }

      const status = (await response.json()) as StagingStatusResponse;
      setDetectedStagingTarget(Boolean(status?.stagingCapability?.applicationUuid));
    } catch {
      // Ignore best-effort status refresh failures.
    }
  }

  useEffect(() => {
    if (enabled) {
      return;
    }

    void refreshStagingTargetStatus();
  }, [enabled, siteId]);

  async function waitForLifecycleCompletion(nextEnabled: boolean, burnExisting: boolean, manualRequired: boolean) {
    // If manual provisioning is required, Jongo has completed what it can server-side.
    if (nextEnabled && manualRequired) {
      return { completed: true };
    }

    for (let attempt = 0; attempt < STAGING_OPERATION_MAX_POLLS; attempt += 1) {
      setFinalizeAttempt(attempt + 1);
      try {
        const response = await fetch(`/api/sites/${siteId}/staging`, { method: "GET" });
        if (response.ok) {
          const status = (await response.json()) as StagingStatusResponse;
          const stagingEnabled = Boolean(status?.stagingEnabled);
          const stagingConfigured = Boolean(status?.stagingConfigured);
          const stagingDetected = Boolean(status?.stagingCapability?.applicationUuid);
          setDetectedStagingTarget(stagingDetected);

          if (nextEnabled) {
            if (stagingEnabled && (stagingConfigured || stagingDetected)) {
              return { completed: true };
            }
          } else if (!stagingEnabled) {
            if (!burnExisting || !stagingDetected) {
              return { completed: true };
            }
          }
        }
      } catch {
        // Keep polling until timeout to avoid transient network errors dropping the operation lock.
      }

      await delay(STAGING_OPERATION_POLL_DELAY_MS);
    }

    return { completed: false };
  }

  async function submitToggle(nextEnabled: boolean, burnExisting: boolean) {
    if (loading) {
      return;
    }

    setError(null);
    setMessage(null);
    setActionHint(null);
    setManualProvisionRequired(false);

    setLoading(true);
    setFinalizing(false);
    setFinalizeAttempt(0);

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
        setActionHint(payload?.actionHint ?? null);
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

      const disableCleanupFailed = !nextEnabled && burnExisting && payload?.destroyed === false;
      if (disableCleanupFailed) {
        setActionHint((previous) => previous ?? "Staging was disabled in Jongo, but resource cleanup failed in the infrastructure panel. Resolve cleanup manually before running another destructive toggle.");
      }

      const shouldFinalize = nextEnabled && !Boolean(payload?.manualProvisionRequired);
      if (shouldFinalize) {
        setFinalizing(true);
        const settleResult = await waitForLifecycleCompletion(nextEnabled, burnExisting, Boolean(payload?.manualProvisionRequired));
        if (!settleResult.completed) {
          setActionHint((previous) => previous ?? "Background staging operation is still settling. Wait a moment before running another toggle.");
        }
        setFinalizing(false);
      }

      if (!nextEnabled) {
        await refreshStagingTargetStatus();
      }

      router.refresh();
    } catch {
      setError("Network error while updating staging.");
      setModalMode("result");
      setModalOpen(true);
      setFinalizing(false);
      setFinalizeAttempt(0);
    } finally {
      setLoading(false);
      setFinalizeAttempt(0);
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
    setFinalizeAttempt(0);
  }

  const interactionLocked = loading || finalizing;
  const enableBlockedByResidualStaging = !enabled && detectedStagingTarget;
  const toggleDisabled = interactionLocked || enableBlockedByResidualStaging;
  const isDisableAction = pendingAction === "disable";
  const isEnableAction = pendingAction === "enable";
  const waitingForManualStagingSetup = enabled && !detectedStagingTarget;
  const showResultBody = modalMode === "result" || Boolean(error || message || actionHint || waitingForManualStagingSetup);
  const settleAttemptsRemaining = Math.max(0, STAGING_OPERATION_MAX_POLLS - finalizeAttempt);
  const settleSecondsRemaining = Math.ceil((settleAttemptsRemaining * STAGING_OPERATION_POLL_DELAY_MS) / 1000);

  return (
    <div style={{ display: "grid", gap: "0.55rem", justifyItems: "end", minWidth: "260px" }}>
      <button
        type="button"
        onClick={requestToggle}
        aria-label={`Turn staging ${enabled ? "off" : "on"}`}
        aria-pressed={enabled}
        disabled={toggleDisabled}
        style={{
          width: "58px",
          height: "32px",
          borderRadius: "999px",
          border: `1px solid ${enabled ? "var(--accent)" : "var(--border)"}`,
          background: enabled ? "var(--accent)" : "var(--surface-alt)",
          position: "relative",
          cursor: toggleDisabled ? "not-allowed" : "pointer",
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
        {interactionLocked
          ? "Updating..."
          : enableBlockedByResidualStaging
            ? "Locked until staging is fully deleted"
            : enabled
              ? "On"
              : "Off"}
      </p>

      {enableBlockedByResidualStaging ? (
        <p style={{ margin: 0, fontSize: "0.78rem", color: "#a15c00", maxWidth: "320px", textAlign: "right" }}>
          Re-enable is blocked while staging resources still exist. Finish unprovisioning in Coolify first.
        </p>
      ) : null}

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
                    ? "Jongo will provision staging when possible. Check the Staging tab in a few minutes."
                    : "Disable staging in Jongo. By default, existing staging resources are removed."}
                </p>

                {isDisableAction && detectedStagingTarget ? (
                  <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginTop: "0.8rem", fontSize: "0.82rem" }}>
                    <input
                      type="checkbox"
                      checked={burnOnDisable}
                      onChange={(event) => setBurnOnDisable(event.target.checked)}
                      disabled={loading}
                    />
                    Remove existing staging resources (destructive)
                  </label>
                ) : null}

                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1rem" }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={cancelPendingAction}
                    disabled={interactionLocked}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => submitToggle(isEnableAction, isDisableAction ? burnOnDisable : false)}
                    disabled={interactionLocked}
                  >
                    {interactionLocked
                      ? "Please wait..."
                      : isEnableAction
                        ? "Accept and enable"
                        : "Accept and disable"}
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
                    {actionHint ?? "Manual provisioning in the infrastructure panel is required before staging will be detected."}
                  </p>
                ) : null}
                {error && actionHint && !manualProvisionRequired ? (
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "#a15c00" }}>
                    {actionHint}
                  </p>
                ) : null}
                {waitingForManualStagingSetup && !manualProvisionRequired ? (
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "#a15c00" }}>
                    Staging is enabled in Jongo, but no staging target is detected yet. Check the Staging tab in Coolify and refresh in a few minutes.
                  </p>
                ) : null}
                {finalizing ? (
                  <div style={{ margin: "0.55rem 0 0", display: "grid", gap: "0.3rem" }}>
                    <p style={{ margin: 0, fontSize: "0.84rem", color: "var(--muted)" }}>
                      Finalizing staging operation. Controls stay locked until this step completes.
                    </p>
                    <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
                      Check {Math.max(1, finalizeAttempt)} of {STAGING_OPERATION_MAX_POLLS} · up to ~{settleSecondsRemaining}s remaining
                    </p>
                  </div>
                ) : null}

                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
                  <button
                    type="button"
                    className="button"
                    onClick={closeResultModal}
                    disabled={interactionLocked}
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
