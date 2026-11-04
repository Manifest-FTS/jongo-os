"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  siteId: string;
  /** Ignored: the server picks the hosting resource from the app. Kept so existing callers compile. */
  deployTargetId?: string;
  environment?: "production" | "staging";
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
};

type DeployView = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: "queued" | "starting" | "building" | null;
  retrying: boolean;
  message: string | null;
};

const POLL_MS = 3000;

function isActive(view: DeployView | null): boolean {
  return view?.status === "queued" || view?.status === "running";
}

function progressText(view: DeployView): string {
  if (view.retrying) return "Hosting didn't respond. Trying again…";
  if (view.stage === "building") return "Building and releasing. This usually takes a few minutes.";
  if (view.stage === "starting") return "Starting the deploy…";
  return "Waiting to start…";
}

export default function DeployButton({
  siteId,
  environment = "production",
  label,
  disabled = false,
  disabledReason
}: Props) {
  const [view, setView] = useState<DeployView | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const follow = useCallback((operationId: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const res = await fetch(`/api/operations/${operationId}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { operation: DeployView };
          setView(data.operation);
          if (!isActive(data.operation)) return;
        }
      } catch {
        // Network blip: keep following.
      }
      timer.current = setTimeout(tick, POLL_MS);
    };
    timer.current = setTimeout(tick, POLL_MS);
  }, []);

  // Pick up a deploy that is already running (another tab, or before a reload).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/coolify/deploy?siteId=${encodeURIComponent(siteId)}&environment=${environment}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { operation: DeployView | null } | null) => {
        if (cancelled || !data?.operation) return;
        setView(data.operation);
        if (isActive(data.operation)) follow(data.operation.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [siteId, environment, follow]);

  async function handleDeploy() {
    if (disabled || sending || isActive(view)) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/coolify/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The server resolves which hosting resource to deploy from the app itself.
        body: JSON.stringify({ siteId, environment })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.operation) {
        setError(data.error ?? "The deploy couldn't be started. Try again shortly.");
        return;
      }
      setView(data.operation);
      follow(data.operation.id);
    } catch {
      setError("Couldn't reach Jongo. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  const active = isActive(view);
  const buttonLabel = label ?? (environment === "staging" ? "Deploy to Staging" : "Deploy to Production");
  const failed = view?.status === "failed" || view?.status === "cancelled";
  const message = error || (view ? (active ? progressText(view) : view.message ?? "") : "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <button
        onClick={handleDeploy}
        disabled={sending || active || disabled}
        className="deploy-btn"
        data-env={environment}
        aria-busy={sending || active}
      >
        {sending || active ? "Deploying…" : buttonLabel}
      </button>
      {disabled && disabledReason && (
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
          Why locked: {disabledReason}
        </p>
      )}
      {message && (
        <p
          role="status"
          aria-live="polite"
          style={{
            margin: 0,
            fontSize: "0.82rem",
            color: error || failed ? "var(--text)" : "var(--muted)"
          }}
          className={error || failed ? "auth-error" : undefined}
        >
          {message}
        </p>
      )}
    </div>
  );
}
