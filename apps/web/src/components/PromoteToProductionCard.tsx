"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import CopyTextButton from "@/components/CopyTextButton";

type Props = {
  siteId: string;
  disabled: boolean;
  disabledReason?: string;
  preflightLabel: string;
  preflightTone: "healthy" | "degraded" | "error" | "unknown";
};

// "backup-wait" is deliberately not "error": promote was declined, but the
// backup it was waiting on is now running, and the message must not read red.
type PromoteStatus = "idle" | "pending" | "success" | "error" | "backup-wait";

type DeploymentStatus = {
  id: string;
  environment: string;
  status: string;
  triggeredAt: string;
  finishedAt?: string;
  coolifyDeploymentId?: string;
  source: "db" | "coolify";
};

type DeploymentsPollResponse = {
  ok: boolean;
  generatedAt?: string;
  latestProduction?: DeploymentStatus | null;
  inProgressProduction?: DeploymentStatus | null;
  latestPromoteAttemptId?: string;
  error?: string;
};

type PromoteAttemptResponse = {
  ok?: boolean;
  error?: string;
  attemptId?: string;
  status?: "blocked" | "triggered" | "in_progress" | "succeeded" | "failed";
  statusLabel?: string;
  statusTone?: "healthy" | "degraded" | "error" | "unknown";
  message?: string;
  deploymentId?: string;
  deploymentStatus?: string;
  blockingReason?: string;
  triggeredAt?: string;
  finishedAt?: string;
  updatedAt?: string;
};

type PromoteResponse = {
  ok?: boolean;
  error?: string;
  message?: string;
  deploymentId?: string;
  promoteAttemptId?: string;
  replayed?: boolean;
  idempotencyKey?: string;
  retryAfterSeconds?: number;
  blockingReason?:
    | "promote_cooldown"
    | "production_deployment_in_progress"
    | "staging_to_production_preflight_blocked"
    | "promote_backup_started"
    | "promote_backup_in_progress";
  actionHint?: string;
  backupId?: string;
  backupStarted?: boolean;
  blockingDeployment?: {
    id?: string;
    status?: string;
    triggeredAt?: string;
  };
};

/**
 * A backup being taken for us is not a failure — promote just has to be asked
 * again once it lands. Rendering it in the error tone made the safest path look
 * like something had gone wrong.
 */
function isBackupWaitReason(payload: PromoteResponse): boolean {
  return (
    payload.blockingReason === "promote_backup_started" ||
    payload.blockingReason === "promote_backup_in_progress"
  );
}

function formatPromoteError(payload: PromoteResponse): string {
  const base = payload.error ?? "Unable to promote staging to production.";

  if (isBackupWaitReason(payload)) {
    const hintSuffix = payload.actionHint ? ` ${payload.actionHint}` : "";
    return `${base}${hintSuffix}`.trim();
  }

  if (payload.blockingReason === "promote_cooldown") {
    const retrySuffix = (payload.retryAfterSeconds ?? 0) > 0
      ? ` Retry in ${payload.retryAfterSeconds}s.`
      : "";
    const hintSuffix = payload.actionHint ? ` ${payload.actionHint}` : "";
    return `${base}${retrySuffix}${hintSuffix}`.trim();
  }

  if (payload.blockingReason === "production_deployment_in_progress") {
    const deploymentId = payload.blockingDeployment?.id;
    const deploymentSuffix = deploymentId ? ` Current deployment: ${deploymentId}.` : "";
    const hintSuffix = payload.actionHint ? ` ${payload.actionHint}` : "";
    return `${base}${deploymentSuffix}${hintSuffix}`.trim();
  }

  if (payload.blockingReason === "staging_to_production_preflight_blocked") {
    const hintSuffix = payload.actionHint ? ` ${payload.actionHint}` : "";
    return `${base}${hintSuffix}`.trim();
  }

  if (payload.actionHint) {
    return `${base} ${payload.actionHint}`.trim();
  }

  return base;
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function isTerminalDeployStatus(status: string): boolean {
  return status === "success" || status === "healthy" || status === "failed" || status === "error";
}

export default function PromoteToProductionCard({
  siteId,
  disabled,
  disabledReason,
  preflightLabel,
  preflightTone
}: Props) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const [status, setStatus] = useState<PromoteStatus>("idle");
  const [message, setMessage] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pollError, setPollError] = useState("");
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [latestProductionDeployment, setLatestProductionDeployment] = useState<DeploymentStatus | null>(null);
  const [inProgressProductionDeployment, setInProgressProductionDeployment] = useState<DeploymentStatus | null>(null);
  const [latestPromoteAttemptId, setLatestPromoteAttemptId] = useState<string | null>(null);
  const [focusedAttempt, setFocusedAttempt] = useState<PromoteAttemptResponse | null>(null);
  const [focusedAttemptError, setFocusedAttemptError] = useState("");
  const [promoteIdempotencyKey, setPromoteIdempotencyKey] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownTick, setCooldownTick] = useState(() => Date.now());

  const fetchAttemptStatus = useCallback(async (attemptId: string | null) => {
    if (!attemptId) {
      setFocusedAttempt(null);
      setFocusedAttemptError("");
      return;
    }

    try {
      const response = await fetch(
        `/api/sites/${siteId}/staging/promote-attempt?attemptId=${encodeURIComponent(attemptId)}`,
        { cache: "no-store" }
      );

      const payload = (await response.json()) as PromoteAttemptResponse;
      if (!response.ok || !payload.ok) {
        setFocusedAttempt(null);
        setFocusedAttemptError(payload.error ?? "Unable to read promote attempt status.");
        return;
      }

      setFocusedAttempt(payload);
      setFocusedAttemptError("");
    } catch {
      setFocusedAttemptError("Network error while reading promote attempt status.");
    }
  }, [siteId]);

  const pollDeployments = useCallback(async () => {
    try {
      const response = await fetch(`/api/sites/${siteId}/deployments?limit=10`, {
        cache: "no-store"
      });
      const payload = (await response.json()) as DeploymentsPollResponse;

      if (!response.ok || !payload.ok) {
        setPollError(payload?.error ?? "Unable to read deployment status.");
        return;
      }

      setLatestProductionDeployment(payload.latestProduction ?? null);
      setInProgressProductionDeployment(payload.inProgressProduction ?? null);
      const attemptId = payload.latestPromoteAttemptId ?? null;
      setLatestPromoteAttemptId(attemptId);
      await fetchAttemptStatus(attemptId);
      setLastPolledAt(payload.generatedAt ?? new Date().toISOString());
      setPollError("");
    } catch {
      setPollError("Network error while reading deployment status.");
    }
  }, [siteId, fetchAttemptStatus]);

  async function refreshDeployments() {
    if (isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    await pollDeployments();
    setIsRefreshing(false);
  }

  useEffect(() => {
    pollDeployments();
    const id = setInterval(pollDeployments, 8_000);
    return () => clearInterval(id);
  }, [pollDeployments]);

  const productionStatusTone = useMemo(() => {
    if (!latestProductionDeployment) {
      return "unknown";
    }

    if (latestProductionDeployment.status === "success" || latestProductionDeployment.status === "healthy") {
      return "healthy";
    }

    if (latestProductionDeployment.status === "failed" || latestProductionDeployment.status === "error") {
      return "error";
    }

    if (latestProductionDeployment.status === "in_progress" || latestProductionDeployment.status === "degraded") {
      return "degraded";
    }

    return "unknown";
  }, [latestProductionDeployment]);

  const latestAttemptDeepLink = useMemo(() => {
    if (!latestPromoteAttemptId) {
      return "";
    }

    return `/sites/${siteId}/staging?attemptId=${encodeURIComponent(latestPromoteAttemptId)}`;
  }, [latestPromoteAttemptId, siteId]);

  useEffect(() => {
    if (!cooldownUntil) {
      return;
    }

    const id = setInterval(() => {
      setCooldownTick(Date.now());
    }, 1_000);

    return () => clearInterval(id);
  }, [cooldownUntil]);

  const cooldownSecondsRemaining = useMemo(() => {
    if (!cooldownUntil) {
      return 0;
    }

    const diff = cooldownUntil - cooldownTick;
    if (diff <= 0) {
      return 0;
    }

    return Math.ceil(diff / 1_000);
  }, [cooldownUntil, cooldownTick]);

  useEffect(() => {
    if (!cooldownUntil || cooldownSecondsRemaining > 0) {
      return;
    }

    setCooldownUntil(null);
  }, [cooldownUntil, cooldownSecondsRemaining]);

  const isPromoteLockedByInProgress = Boolean(inProgressProductionDeployment);
  const isPromoteLockedByCooldown = cooldownSecondsRemaining > 0;
  const isPromoteLocked = disabled || status === "pending" || isPromoteLockedByInProgress || isPromoteLockedByCooldown;
  const promoteLockReason = isPromoteLockedByInProgress
    ? "Promotion is locked while production deployment is in progress."
    : isPromoteLockedByCooldown
      ? `Promotion temporarily rate-limited. Retry in ${cooldownSecondsRemaining}s.`
      : disabledReason;

  useEffect(() => {
    if (!showConfirm || !isPromoteLockedByInProgress) {
      return;
    }

    setShowConfirm(false);
    setConfirmationPhrase("");
    setPromoteIdempotencyKey("");
    setStatus("idle");
    setMessage("Promotion is locked while production deployment is in progress.");
  }, [showConfirm, isPromoteLockedByInProgress]);

  async function submitPromote() {
    if (status === "pending" || isPromoteLocked) {
      return;
    }

    const requestIdempotencyKey = promoteIdempotencyKey || crypto.randomUUID();
    if (!promoteIdempotencyKey) {
      setPromoteIdempotencyKey(requestIdempotencyKey);
    }

    setStatus("pending");
    setMessage("");

    try {
      const response = await fetch(`/api/sites/${siteId}/staging/promote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestIdempotencyKey
        },
        body: JSON.stringify({ confirmationPhrase, idempotencyKey: requestIdempotencyKey })
      });

      const payload = (await response.json()) as PromoteResponse;
      if (!response.ok) {
        if ((payload?.retryAfterSeconds ?? 0) > 0 || payload?.blockingReason === "promote_cooldown") {
          const retrySeconds = Math.max(1, payload?.retryAfterSeconds ?? 0);
          setCooldownUntil(Date.now() + retrySeconds * 1_000);
        }

        // A first-run backup is now running on our behalf. Dismiss the
        // confirmation rather than leaving a typed PROMOTE sitting there for a
        // wait of unknown length, and refresh so the Backups tab shows it.
        if (isBackupWaitReason(payload)) {
          setStatus("backup-wait");
          setMessage(formatPromoteError(payload));
          setShowConfirm(false);
          setConfirmationPhrase("");
          setPromoteIdempotencyKey("");
          router.refresh();
          return;
        }

        setStatus("error");
        setMessage(formatPromoteError(payload));
        return;
      }

      setStatus("success");
      setCooldownUntil(null);
      setShowConfirm(false);
      setConfirmationPhrase("");
      setPromoteIdempotencyKey("");
      const defaultMessage = payload?.deploymentId
        ? `Production promotion triggered (${payload.deploymentId}).`
        : "Production promotion triggered.";
      const attemptSuffix = payload?.promoteAttemptId ? ` Attempt ${payload.promoteAttemptId}.` : "";
      const replaySuffix = payload?.replayed ? " (replayed request)" : "";
      setMessage(`${payload?.message ?? defaultMessage}${attemptSuffix}${replaySuffix}`.trim());
      if (payload?.promoteAttemptId) {
        setLatestPromoteAttemptId(payload.promoteAttemptId);
        await fetchAttemptStatus(payload.promoteAttemptId);
      }
      await pollDeployments();
      router.refresh();
    } catch {
      setStatus("error");
      setMessage("Network error while promoting staging to production.");
    }
  }

  function openConfirmPanel() {
    if (isPromoteLocked) {
      return;
    }

    setMessage("");
    setStatus("idle");
    setPromoteIdempotencyKey(crypto.randomUUID());
    setShowConfirm(true);
  }

  function cancelConfirmPanel() {
    if (status === "pending") {
      return;
    }

    setShowConfirm(false);
    setConfirmationPhrase("");
    setPromoteIdempotencyKey("");
  }

  return (
    <div style={{ display: "grid", gap: "0.6rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span className={`status-chip ${preflightTone}`}>{preflightLabel}</span>
        <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>Production promotion preflight</span>
      </div>

      <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
        This action copies staging WordPress files and database content into production, then triggers a production deployment.
      </p>

      <button
        type="button"
        className="button"
        onClick={openConfirmPanel}
        disabled={isPromoteLocked}
      >
        {status === "pending" ? "Promoting staging to production..." : "Promote to production"}
      </button>

      {isPromoteLocked && promoteLockReason ? (
        <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
          Why locked: {promoteLockReason}
        </p>
      ) : null}

      {isPromoteLockedByCooldown ? (
        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
          Cooldown active: retry available in {cooldownSecondsRemaining}s.
        </p>
      ) : null}

      {showConfirm ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "10px",
            background: "var(--surface-alt)",
            padding: "0.75rem",
            display: "grid",
            gap: "0.6rem"
          }}
        >
          <p style={{ margin: 0, fontSize: "0.87rem", fontWeight: 600 }}>Confirm production promotion</p>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
            Type <strong>PROMOTE</strong> to copy staging WordPress content and files into production, then trigger the production deployment.
          </p>
          <input
            type="text"
            value={confirmationPhrase}
            onChange={(event) => setConfirmationPhrase(event.target.value)}
            placeholder="PROMOTE"
            style={{
              width: "100%",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              background: "var(--surface)",
              color: "var(--text)",
              padding: "0.5rem 0.6rem",
              fontSize: "0.85rem"
            }}
            disabled={status === "pending"}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={cancelConfirmPanel}
              disabled={status === "pending"}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              onClick={submitPromote}
              disabled={isPromoteLocked || confirmationPhrase.trim().toUpperCase() !== "PROMOTE"}
            >
              Confirm promotion
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          style={{
            margin: 0,
            fontSize: "0.82rem",
            color: status === "error" ? "var(--error, #c0392b)" : "var(--muted)"
          }}
        >
          {message}
        </p>
      ) : null}

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.6rem", display: "grid", gap: "0.35rem" }}>
        {focusedAttempt ? (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "8px",
              background: "var(--surface-alt)",
              padding: "0.6rem",
              marginBottom: "0.5rem",
              display: "grid",
              gap: "0.25rem"
            }}
          >
            <p style={{ margin: 0, fontSize: "0.8rem", fontWeight: 600 }}>
              Focused attempt: {focusedAttempt.attemptId}
            </p>
            <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
              <span className={`status-chip ${focusedAttempt.statusTone ?? "unknown"}`}>
                {focusedAttempt.statusLabel ?? "unknown"}
              </span>{" "}
              {focusedAttempt.message}
            </p>
            {focusedAttempt.deploymentId ? (
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
                Deployment: {focusedAttempt.deploymentId}
                {focusedAttempt.deploymentStatus ? ` (${focusedAttempt.deploymentStatus.replace("_", " ")})` : ""}
              </p>
            ) : null}
            {focusedAttempt.finishedAt ? (
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
                Completed {formatAgo(focusedAttempt.finishedAt)}
              </p>
            ) : focusedAttempt.triggeredAt ? (
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
                Started {formatAgo(focusedAttempt.triggeredAt)}
              </p>
            ) : null}
          </div>
        ) : null}

        {focusedAttemptError ? (
          <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--error, #c0392b)" }}>
            {focusedAttemptError}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center" }}>
          <p style={{ margin: 0, fontSize: "0.82rem", fontWeight: 600 }}>Production deployment status</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={refreshDeployments}
            disabled={isRefreshing}
            style={{ padding: "0.35rem 0.6rem", fontSize: "0.78rem" }}
          >
            {isRefreshing ? "Refreshing…" : "Refresh status"}
          </button>
        </div>

        {inProgressProductionDeployment ? (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
            <span className="status-chip degraded">in progress</span>{" "}
            started {formatAgo(inProgressProductionDeployment.triggeredAt)}
          </p>
        ) : null}

        {latestProductionDeployment ? (
          <div style={{ display: "grid", gap: "0.25rem" }}>
            <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
              Latest: <span className={`status-chip ${productionStatusTone}`}>{latestProductionDeployment.status.replace("_", " ")}</span>{" "}
              {formatAgo(latestProductionDeployment.triggeredAt)}
              {latestProductionDeployment.coolifyDeploymentId
                ? ` (deployment ${latestProductionDeployment.coolifyDeploymentId})`
                : ""}
            </p>
            {isTerminalDeployStatus(latestProductionDeployment.status) && latestProductionDeployment.finishedAt ? (
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
                Completed {formatAgo(latestProductionDeployment.finishedAt)}
              </p>
            ) : null}
            {latestPromoteAttemptId ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
                <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
                  Attempt id: <code>{latestPromoteAttemptId}</code>
                </p>
                <CopyTextButton value={latestPromoteAttemptId} label="Copy attempt id" />
                <CopyTextButton value={latestAttemptDeepLink} label="Copy deep link" />
              </div>
            ) : null}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
            No production deployment activity recorded yet.
          </p>
        )}

        {lastPolledAt ? (
          <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--muted)" }}>
            Last checked {formatAgo(lastPolledAt)}
          </p>
        ) : null}

        {pollError ? (
          <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--error, #c0392b)" }}>
            {pollError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
