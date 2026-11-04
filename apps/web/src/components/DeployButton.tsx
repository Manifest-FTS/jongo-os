"use client";

import { deployProgressText, useDeployOperation } from "@/components/useDeployOperation";

type Props = {
  siteId: string;
  /** Ignored: the server picks the hosting resource from the app. Kept so existing callers compile. */
  deployTargetId?: string;
  environment?: "production" | "staging";
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
};

export default function DeployButton({
  siteId,
  environment = "production",
  label,
  disabled = false,
  disabledReason
}: Props) {
  const { view, sending, error, active, start } = useDeployOperation(siteId, environment);

  const buttonLabel = label ?? (environment === "staging" ? "Deploy to Staging" : "Deploy to Production");
  const failed = view?.status === "failed" || view?.status === "cancelled";
  const message = error || (view ? (active ? deployProgressText(view) : view.message ?? "") : "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <button
        onClick={() => {
          if (!disabled && !sending && !active) void start();
        }}
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
          style={{ margin: 0, fontSize: "0.82rem", color: error || failed ? "var(--text)" : "var(--muted)" }}
          className={error || failed ? "auth-error" : undefined}
        >
          {message}
        </p>
      )}
    </div>
  );
}
