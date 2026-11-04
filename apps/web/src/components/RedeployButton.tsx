"use client";

import { useState } from "react";
import { deployProgressText, useDeployOperation } from "@/components/useDeployOperation";

type Props = {
  siteId: string;
  /** WordPress and other services restart instead of rebuilding. */
  kind: "deploy" | "restart";
};

/**
 * Redeploy the live app, like Vercel's Redeploy. Asks once before starting,
 * because the app is briefly unavailable while it restarts. Shows progress
 * until the deploy finishes and picks up one already running.
 */
export default function RedeployButton({ siteId, kind }: Props) {
  const { view, sending, error, active, start } = useDeployOperation(siteId, "production");
  const [confirming, setConfirming] = useState(false);

  const label = kind === "restart" ? "Restart" : "Redeploy";
  const busyLabel = kind === "restart" ? "Restarting…" : "Redeploying…";
  const failed = view?.status === "failed" || view?.status === "cancelled";
  // A finished result stays visible for 10 minutes (that is all the API returns).
  const message = error || (view ? (active ? deployProgressText(view, kind) : view.message ?? "") : "");

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.35rem", maxWidth: "22rem" }}>
      {confirming && !active ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
            {kind === "restart"
              ? "Restart the live app? It is offline for a moment."
              : "Redeploy the live app from its latest code?"}
          </span>
          <button
            type="button"
            className="btn btn--primary"
            disabled={sending}
            onClick={async () => {
              await start();
              setConfirming(false);
            }}
          >
            {sending ? busyLabel : label}
          </button>
          <button type="button" className="btn btn-secondary" disabled={sending} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={active}
          aria-busy={active}
          onClick={() => setConfirming(true)}
        >
          {active ? busyLabel : label}
        </button>
      )}
      {message ? (
        <p
          role="status"
          aria-live="polite"
          style={{ margin: 0, fontSize: "0.8rem", textAlign: "right", color: error || failed ? "var(--text)" : "var(--muted)" }}
          className={error || failed ? "auth-error" : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
