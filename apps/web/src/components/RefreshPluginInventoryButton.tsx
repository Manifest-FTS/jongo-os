"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  /** Rendered when the cache has something, so the reader knows how old it is. */
  collectedLabel?: string | null;
};

type RefreshResponse = {
  ok?: boolean;
  status?: string;
  message?: string;
  installed?: number;
  updatesAvailable?: number;
};

/**
 * Re-reads the plugin inventory on demand.
 *
 * The page renders from a cache refreshed hourly, which is the right default —
 * a page load should not SSH into the production host. But after updating a
 * plugin you want to see it now, and "wait up to an hour" is not an answer.
 */
export default function RefreshPluginInventoryButton({ siteId, collectedLabel }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "warn" | "error">("ok");

  async function refresh() {
    if (busy) return;
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/sites/${siteId}/plugins/refresh`, { method: "POST" });
      const payload = (await response.json()) as RefreshResponse;

      if (payload?.ok) {
        setTone("ok");
        setMessage(payload.message ?? "Plugin inventory refreshed.");
        router.refresh();
      } else {
        // A deploy in progress is a "try again shortly", not a failure.
        setTone(payload?.status === "deferred_deploy_in_progress" ? "warn" : "error");
        setMessage(payload?.message ?? "Could not refresh the plugin inventory.");
      }
    } catch {
      setTone("error");
      setMessage("Network error while refreshing the plugin inventory.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.3rem", justifyItems: "start" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary" onClick={refresh} disabled={busy}>
          {busy ? "Reading container…" : "Refresh inventory"}
        </button>
        {collectedLabel ? (
          <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>{collectedLabel}</span>
        ) : null}
      </div>
      {message ? (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: "0.8rem",
            color: tone === "error" ? "var(--error, #c0392b)" : "var(--muted)"
          }}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
