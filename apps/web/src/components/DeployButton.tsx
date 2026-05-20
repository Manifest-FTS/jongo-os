"use client";

import { useState } from "react";

type Props = {
  siteId: string;
  deployTargetId?: string;
  environment?: "production" | "staging";
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
};

export default function DeployButton({
  siteId,
  deployTargetId,
  environment = "production",
  label,
  disabled = false,
  disabledReason
}: Props) {
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleDeploy() {
    if (disabled) {
      return;
    }

    setStatus("pending");
    setMessage("");

    try {
      const res = await fetch("/api/coolify/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceUuid: deployTargetId ?? siteId, environment })
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Deploy failed.");
      } else {
        setStatus("success");
        setMessage(data.message ?? `Deploy triggered (${data.deploymentId}).`);
      }
    } catch {
      setStatus("error");
      setMessage("Network error — could not reach deploy API.");
    }
  }

  const buttonLabel = label ?? (environment === "staging" ? "Deploy to Staging" : "Deploy to Production");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <button
        onClick={handleDeploy}
        disabled={status === "pending" || disabled}
        className="deploy-btn"
        data-env={environment}
      >
        {status === "pending" ? "Deploying…" : buttonLabel}
      </button>
      {disabled && disabledReason && (
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
          Why locked: {disabledReason}
        </p>
      )}
      {message && (
        <p
          style={{
            margin: 0,
            fontSize: "0.82rem",
            color: status === "error" ? "var(--text)" : "var(--muted)"
          }}
          className={status === "error" ? "auth-error" : undefined}
        >
          {message}
        </p>
      )}
    </div>
  );
}
