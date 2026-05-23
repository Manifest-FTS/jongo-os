"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  disabled: boolean;
  disabledReason?: string;
  preflightLabel: string;
  preflightTone: "healthy" | "degraded" | "error" | "unknown";
};

type PromoteStatus = "idle" | "pending" | "success" | "error";

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
  error?: string;
};

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
      setLastPolledAt(payload.generatedAt ?? new Date().toISOString());
      setPollError("");
    } catch {
      setPollError("Network error while reading deployment status.");
    }
  }, [siteId]);

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

  async function submitPromote() {
    if (status === "pending") {
      return;
    }

    setStatus("pending");
    setMessage("");

    try {
      const response = await fetch(`/api/sites/${siteId}/staging/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationPhrase })
      });

      const payload = await response.json();
      if (!response.ok) {
        setStatus("error");
        setMessage(payload?.error ?? "Unable to trigger production deployment.");
        return;
      }

      setStatus("success");
      setShowConfirm(false);
      setConfirmationPhrase("");
      setMessage(payload?.message ?? `Production deploy triggered (${payload?.deploymentId ?? "unknown"}).`);
      await pollDeployments();
      router.refresh();
    } catch {
      setStatus("error");
      setMessage("Network error while triggering production deployment.");
    }
  }

  function openConfirmPanel() {
    if (disabled || status === "pending") {
      return;
    }

    setMessage("");
    setStatus("idle");
    setShowConfirm(true);
  }

  function cancelConfirmPanel() {
    if (status === "pending") {
      return;
    }

    setShowConfirm(false);
    setConfirmationPhrase("");
  }

  return (
    <div style={{ display: "grid", gap: "0.6rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span className={`status-chip ${preflightTone}`}>{preflightLabel}</span>
        <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>Preflight status</span>
      </div>

      <button
        type="button"
        className="button"
        onClick={openConfirmPanel}
        disabled={disabled || status === "pending"}
      >
        {status === "pending" ? "Triggering production deploy..." : "Promote staging to production"}
      </button>

      {disabled && disabledReason ? (
        <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
          Why locked: {disabledReason}
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
            This triggers a production deployment in Coolify. Type <strong>PROMOTE</strong> to continue.
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
              disabled={status === "pending" || confirmationPhrase.trim().toUpperCase() !== "PROMOTE"}
            >
              Confirm promote
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
