"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toClientFacingStagingMessage } from "@/lib/staging-client-copy";
import RemedyButton from "@/components/RemedyButton";
import { remedy as buildRemedy, type Remedy } from "@/lib/remedies";

type Props = {
  siteId: string;
  initialEnabled: boolean;
  hasDetectedStagingTarget: boolean;
  /** The detected copy is the one Jongo recorded for this app, so enabling re-attaches it. */
  hasOwnStagingTarget?: boolean;
  showInfrastructureDetails?: boolean;
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
  /** In-app fix (retry cleanup / retry setup) when the toggle could not finish. */
  remedy?: Remedy | null;
  /** Several servers and none known: the admin picks where staging runs. */
  serverChoices?: Array<{ uuid: string; name: string }> | null;
};

type StagingStatusResponse = {
  stagingEnabled?: boolean;
  stagingConfigured?: boolean;
  stagingCapability?: {
    detected?: boolean;
    applicationUuid?: string;
    pinned?: boolean;
  };
};

const STAGING_OPERATION_POLL_DELAY_MS = 1500;
const STAGING_OPERATION_MAX_POLLS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function SiteStagingToggle({
  siteId,
  initialEnabled,
  hasDetectedStagingTarget,
  hasOwnStagingTarget = false,
  showInfrastructureDetails = false
}: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [detectedStagingTarget, setDetectedStagingTarget] = useState(hasDetectedStagingTarget);
  const [ownStagingTarget, setOwnStagingTarget] = useState(hasOwnStagingTarget);
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
  const [resultRemedy, setResultRemedy] = useState<Remedy | null>(null);
  const [serverChoices, setServerChoices] = useState<Array<{ uuid: string; name: string }>>([]);
  const [chosenServer, setChosenServer] = useState("");
  const [choosingServer, setChoosingServer] = useState(false);

  async function enableOnServer() {
    if (!chosenServer) return;
    setChoosingServer(true);
    try {
      const response = await fetch(`/api/sites/${siteId}/staging`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, stagingServerUuid: chosenServer })
      });
      const payload = ((await response.json().catch(() => ({}))) ?? {}) as StagingToggleResponse;
      setMessage(visibleMessage(payload?.message ?? payload?.error) ?? "Staging setup started.");
      setActionHint(visibleMessage(payload?.actionHint));
      setServerChoices(payload?.serverChoices ?? []);
      setResultRemedy(payload?.remedy ?? null);
      setManualProvisionRequired(Boolean(payload?.manualProvisionRequired));
      router.refresh();
    } catch {
      setError("Network error while updating staging.");
    } finally {
      setChoosingServer(false);
    }
  }
  const visibleMessage = (value?: string | null) =>
    showInfrastructureDetails ? value ?? null : toClientFacingStagingMessage(value);

  useEffect(() => {
    setDetectedStagingTarget(hasDetectedStagingTarget);
  }, [hasDetectedStagingTarget]);

  useEffect(() => {
    setOwnStagingTarget(hasOwnStagingTarget);
  }, [hasOwnStagingTarget]);

  async function refreshStagingTargetStatus() {
    try {
      const response = await fetch(`/api/sites/${siteId}/staging`, { method: "GET" });
      if (!response.ok) {
        return;
      }

      const status = (await response.json()) as StagingStatusResponse;
      setDetectedStagingTarget(Boolean(status?.stagingCapability?.applicationUuid));
      setOwnStagingTarget(Boolean(status?.stagingCapability?.pinned));
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
          setOwnStagingTarget(Boolean(status?.stagingCapability?.pinned));

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

      let payload: StagingToggleResponse = {};
      try {
        payload = (await response.json()) as StagingToggleResponse;
      } catch {
        if (!response.ok) {
          payload = { error: `Unable to update staging state (HTTP ${response.status}).` };
        }
      }

      setResultRemedy(payload?.remedy ?? null);
      setServerChoices(payload?.serverChoices ?? []);
      if (!response.ok) {
        setError(visibleMessage(payload?.error) ?? "Unable to update staging state.");
        setActionHint(visibleMessage(payload?.actionHint));
        setModalMode("result");
        setModalOpen(true);
        return;
      }

      setEnabled(nextEnabled);
      setPendingAction(null);
      setBurnOnDisable(true);
      setMessage(visibleMessage(payload?.message) ?? (nextEnabled ? "Staging enabled." : "Staging disabled."));
      setActionHint(visibleMessage(payload?.actionHint));
      setManualProvisionRequired(Boolean(payload?.manualProvisionRequired));
      setModalMode("result");
      setModalOpen(true);

      const disableCleanupFailed = !nextEnabled && burnExisting && payload?.destroyed === false;
      if (disableCleanupFailed) {
        setActionHint((previous) => previous ?? "Staging is off, but the old staging copy is still there. Use Remove old staging copy to try again.");
        setResultRemedy((previous) => previous ?? buildRemedy("retry_staging_cleanup"));
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
  // Locked only for a copy Jongo did not record. The app's own recorded copy
  // is re-attached by enabling, so it must never lock the switch.
  const enableBlockedByResidualStaging = !enabled && detectedStagingTarget && !ownStagingTarget;
  const canReattachOwnStaging = !enabled && detectedStagingTarget && ownStagingTarget;
  const toggleDisabled = interactionLocked || enableBlockedByResidualStaging;
  const isDisableAction = pendingAction === "disable";
  const isEnableAction = pendingAction === "enable";
  const waitingForManualStagingSetup = enabled && !detectedStagingTarget;
  const showPendingStagingHint = waitingForManualStagingSetup && !manualProvisionRequired && !error;
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
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: enabled ? "flex-start" : "flex-end",
            padding: "0 9px",
            color: "#fff",
            fontSize: "0.75rem",
            fontWeight: 700,
            letterSpacing: "0.02em"
          }}
        >
          {enabled ? "ON" : "OFF"}
        </span>
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

      {interactionLocked ? (
        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Updating...</p>
      ) : null}

      {!interactionLocked && enableBlockedByResidualStaging ? (
        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Locked until staging is fully deleted</p>
      ) : null}

      {!interactionLocked && canReattachOwnStaging ? (
        <p className="m-0 max-w-[320px] text-right text-[0.78rem] text-muted">
          Your staging copy still exists. Turning staging on reconnects it.
        </p>
      ) : null}

      {enableBlockedByResidualStaging ? (
        <div className="flex flex-col items-end gap-1.5 max-w-[320px] text-right">
          <p style={{ margin: 0, fontSize: "0.78rem", color: "#a15c00" }}>
            An old staging copy still exists and has to be removed before staging can be turned on.
          </p>
          <RemedyButton
            remedy={buildRemedy("retry_staging_cleanup")}
            endpoint={`/api/sites/${siteId}/remedies`}
            confirmText="Remove the old staging copy of this app? Production is not touched."
            onDone={(ok) => {
              if (ok) {
                void refreshStagingTargetStatus();
                router.refresh();
              }
            }}
          />
        </div>
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
                    ? "Jongo creates the staging copy now. It appears on this page in a few minutes."
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
                    {actionHint ?? "Staging setup didn't finish. Use Try again."}
                  </p>
                ) : null}
                {error && actionHint && !manualProvisionRequired ? (
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "#a15c00" }}>
                    {actionHint}
                  </p>
                ) : null}
                {showPendingStagingHint ? (
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.84rem", color: "#a15c00" }}>
                    Staging setup is still finishing. Wait a few minutes and refresh.
                  </p>
                ) : null}
                {serverChoices.length > 0 ? (
                  <div className="mt-2.5 flex gap-2 flex-wrap items-center">
                    <select
                      className="form-input min-w-[200px]"
                      value={chosenServer}
                      onChange={(event) => setChosenServer(event.target.value)}
                      aria-label="Server for staging"
                    >
                      <option value="">Choose a server…</option>
                      {serverChoices.map((server) => (
                        <option key={server.uuid} value={server.uuid}>{server.name}</option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" disabled={!chosenServer || choosingServer} onClick={() => void enableOnServer()}>
                      {choosingServer ? "Setting up…" : "Create staging here"}
                    </button>
                  </div>
                ) : null}
                {resultRemedy ? (
                  <div style={{ margin: "0.6rem 0 0" }}>
                    <RemedyButton
                      key={resultRemedy.action}
                      remedy={resultRemedy}
                      endpoint={`/api/sites/${siteId}/remedies`}
                      onDone={(ok) => {
                        if (ok) {
                          void refreshStagingTargetStatus();
                          router.refresh();
                        }
                      }}
                    />
                  </div>
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
