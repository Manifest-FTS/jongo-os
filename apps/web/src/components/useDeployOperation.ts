"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Start a deploy of an app and follow it to the end. Shared by the Redeploy
 * button and the older DeployButton, so both show the same progress and both
 * pick up a deploy that is already running (another tab, or before a reload).
 *
 * Polls every 3s while a deploy is active and stops as soon as it finishes.
 */
export type DeployView = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: "queued" | "starting" | "building" | null;
  retrying: boolean;
  message: string | null;
  finishedAt?: string | null;
};

const POLL_MS = 3000;

export function isDeployActive(view: DeployView | null): boolean {
  return view?.status === "queued" || view?.status === "running";
}

export function deployProgressText(view: DeployView, kind: "deploy" | "restart" = "deploy"): string {
  if (view.retrying) return "Hosting didn't respond. Trying again…";
  if (view.stage === "building") return "Building and releasing. This usually takes a few minutes.";
  if (view.stage === "starting") return kind === "restart" ? "Restarting…" : "Starting the deploy…";
  return "Waiting to start…";
}

export function useDeployOperation(siteId: string, environment: "production" | "staging") {
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
          if (!isDeployActive(data.operation)) return;
        }
      } catch {
        // Network blip: keep following.
      }
      timer.current = setTimeout(tick, POLL_MS);
    };
    timer.current = setTimeout(tick, POLL_MS);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/coolify/deploy?siteId=${encodeURIComponent(siteId)}&environment=${environment}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { operation: DeployView | null } | null) => {
        if (cancelled || !data?.operation) return;
        setView(data.operation);
        if (isDeployActive(data.operation)) follow(data.operation.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [siteId, environment, follow]);

  const start = useCallback(async () => {
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
  }, [siteId, environment, follow]);

  return { view, sending, error, active: isDeployActive(view), start };
}
