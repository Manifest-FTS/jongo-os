"use client";

import { useState } from "react";

type Props = {
  siteId: string;
};

/**
 * One-click restore TEST trigger. Restores the latest offsite dump into an
 * isolated container and records the result (the "Restore verified" chip).
 * It never touches the live database.
 */
export default function RestoreTestButton({ siteId }: Props) {
  const [status, setStatus] = useState<"idle" | "pending" | "started" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleClick() {
    setStatus("pending");
    setMessage("");
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/backup-restore-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        setStatus("error");
        setMessage(data.message ?? data.error ?? "Restore test could not be started.");
      } else {
        setStatus("started");
        setMessage(data.message ?? "Restore test started.");
      }
    } catch {
      setStatus("error");
      setMessage("Network error — could not reach the restore-test API.");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <button
        type="button"
        className="button button-secondary"
        onClick={handleClick}
        disabled={status === "pending" || status === "started"}
      >
        {status === "pending" ? "Starting…" : status === "started" ? "Restore test running…" : "Run restore test"}
      </button>
      {message ? (
        <p
          style={{
            margin: 0,
            fontSize: "0.78rem",
            color: status === "error" ? "var(--danger, #b00020)" : "var(--muted)"
          }}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
