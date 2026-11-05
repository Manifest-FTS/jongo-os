"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toClientFacingStagingMessage } from "@/lib/staging-client-copy";
import RemedyButton from "@/components/RemedyButton";
import { remedy as buildRemedy, type Remedy } from "@/lib/remedies";
import CreationProgress, { applyStep, postWithProgress, type CreationStep } from "@/components/CreationProgress";

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
  /** Another change to this app's staging is already running. */
  inProgress?: boolean;
};

type ToggleInProgress = { operationId: string; enabled: boolean; startedAt: string } | null;

type StagingStatusResponse = {
  stagingEnabled?: boolean;
  stagingConfigured?: boolean;
  stagingCapability?: {
    detected?: boolean;
    applicationUuid?: string;
    pinned?: boolean;
  };
  toggleInProgress?: ToggleInProgress;
};

const STAGING_OPERATION_POLL_DELAY_MS = 1500;
const STAGING_OPERATION_MAX_POLLS = 20;
const IN_PROGRESS_POLL_MS = 4000;

/** What the checklist shows before the server reports its first step. */
function initialSteps(nextEnabled: boolean): CreationStep[] {
  return nextEnabled
    ? [{ id: "check", label: "Checking for an existing staging copy", status: "active" }]
    : [{ id: "disable", label: "Turning staging off", status: "active" }];
}

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
  const [steps, setSteps] = useState<CreationStep[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [runningAction, setRunningAction] = useState<PendingAction>(null);
  /** A change started elsewhere (another tab, a reload mid-change). */
  const [elsewhere, setElsewhere] = useState<ToggleInProgress>(null);

  async function enableOnServer() {
    if (!chosenServer) return;
    setChoosingServer(true);
    setSteps(initialSteps(true));
    setStartedAt(Date.now());
    setRunningAction("enable");
    try {
      const response = await postWithProgress(
        `/api/sites/${siteId}/staging`,
        { enabled: true, stagingServerUuid: chosenServer },
        (step) => setSteps((current) => applyStep(current, step))
      );
      const payload = (response.body ?? {}) as StagingToggleResponse;
      if (response.status >= 200 && response.status < 300) setEnabled(true);
      else setError(visibleMessage(payload?.error) ?? "Staging couldn't be set up on that server.");
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
      setRunningAction(null);
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
      setElsewhere(status?.toggleInProgress ?? null);
      return status;
    } catch {
      // Ignore best-effort status refresh failures.
    }
    return null;
  }

  useEffect(() => {
    void refreshStagingTargetStatus();
  }, [enabled, siteId]);

  // While a change started elsewhere runs, keep the switch locked and check
  // back until it finishes, then show the result.
  useEffect(() => {
    if (!elsewhere || loading) return;
    const timer = setTimeout(async () => {
      const status = await refreshStagingTargetStatus();
      if (status && !status.toggleInProgress) {
        setEnabled(Boolean(status.stagingEnabled));
        router.refresh();
      }
    }, IN_PROGRESS_POLL_MS);
    return () => clearTimeout(timer);
  }, [elsewhere, loading, siteId]);

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

  async function submitToggle(nextEnabled: boolean, burnExisting: boolean, replaceExisting = false) {
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
    setSteps(initialSteps(nextEnabled));
    setStartedAt(Date.now());
    setRunningAction(nextEnabled ? "enable" : "disable");
    setModalMode("result");
    setModalOpen(true);

    try {
      const streamed = await postWithProgress(
        `/api/sites/${siteId}/staging`,
        { enabled: nextEnabled, burnExisting, ...(replaceExisting ? { replaceExisting: true } : {}) },
        (step) => setSteps((current) => applyStep(current, step))
      );
      const response = { ok: streamed.status >= 200 && streamed.status < 300, status: streamed.status };
      const payload: StagingToggleResponse = (streamed.body ?? {}) as StagingToggleResponse;
      if (!response.ok && !payload.error && !payload.message) {
        payload.error = `Unable to update staging state (HTTP ${response.status}).`;
      }
      // Close the checklist off: the first step is a placeholder the server
      // may not report when it took another path.
      setSteps((current) => current.map((step) => (step.status === "active" ? { ...step, status: response.ok ? "done" : "failed" } : step)));

      setResultRemedy(payload?.remedy ?? null);
      setServerChoices(payload?.serverChoices ?? []);
      if (response.status === 409 && payload?.inProgress) {
        // Someone else's change is running: watch it instead of starting another.
        setPendingAction(null);
        setModalOpen(false);
        setModalMode("confirm");
        await refreshStagingTargetStatus();
        return;
      }
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
          setActionHint((previous) => previous ?? "Staging is still starting up. It shows on this page in a minute or two.");
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
      setRunningAction(null);
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
      // The change keeps running; the switch shows "Updating…" until it ends.
      setModalOpen(false);
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

  const interactionLocked = loading || finalizing || Boolean(elsewhere);
  // A copy Jongo did not record: turning staging on replaces it with a fresh
  // one (removing it first). The app's own recorded copy is reconnected.
  const leftoverCopy = !enabled && detectedStagingTarget && !ownStagingTarget;
  const canReattachOwnStaging = !enabled && detectedStagingTarget && ownStagingTarget;
  const toggleDisabled = interactionLocked;
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
            padding: "0 7px",
            color: enabled ? "#fff" : "var(--muted)",
            fontSize: "0.66rem",
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

      {elsewhere && !loading ? (
        <p className="m-0 max-w-[320px] text-right text-[0.78rem] text-muted" aria-live="polite">
          <span className="loader__spinner" style={{ width: 11, height: 11, display: "inline-block", marginRight: 6, verticalAlign: "-1px" }} aria-hidden="true" />
          {elsewhere.enabled ? "Staging is being set up…" : "Staging is being turned off…"}
        </p>
      ) : interactionLocked ? (
        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Updating…</p>
      ) : null}


      {!interactionLocked && canReattachOwnStaging ? (
        <p className="m-0 max-w-[320px] text-right text-[0.78rem] text-muted">
          Your staging copy still exists. Turning staging on reconnects it.
        </p>
      ) : null}

      {!interactionLocked && leftoverCopy ? (
        <p className="m-0 max-w-[320px] text-right text-[0.78rem] text-muted">
          An earlier staging copy is still on the server. Turning staging on replaces it with a fresh one.
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
                ? (isEnableAction ? "Turn on staging" : "Turn off staging")
                : runningAction
                  ? (runningAction === "enable" ? "Setting up staging" : "Turning staging off")
                  : "Staging update"}
            </p>

            {modalMode === "result" && steps.length > 0 ? (
              <div style={{ marginTop: "0.75rem" }}>
                <CreationProgress
                  title={runningAction ? "Progress" : error ? "What happened" : "Done"}
                  steps={steps}
                  startedAt={startedAt}
                  running={Boolean(runningAction)}
                  note={
                    runningAction === "enable"
                      ? "This takes a few minutes. You can close this page; staging keeps being set up and shows here when it's ready."
                      : runningAction === "disable"
                        ? "You can close this page; this keeps running."
                        : ""
                  }
                />
              </div>
            ) : null}

            {modalMode === "confirm" ? (
              <>
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                  {isEnableAction
                    ? leftoverCopy
                      ? "An earlier staging copy is still on the server. Jongo removes it and builds a fresh copy from production. Your live site isn't touched."
                      : canReattachOwnStaging
                        ? "Jongo reconnects your existing staging copy. It's ready in a minute or two."
                        : "Jongo builds a staging copy from production. It's ready in a few minutes; your live site isn't touched."
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
                    onClick={() => submitToggle(isEnableAction, isDisableAction ? burnOnDisable : false, isEnableAction && leftoverCopy)}
                    disabled={interactionLocked}
                  >
                    {interactionLocked
                      ? "Please wait…"
                      : isEnableAction
                        ? "Turn on staging"
                        : "Turn off staging"}
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
                    disabled={finalizing && !loading}
                  >
                    {loading ? "Hide" : "Close"}
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
