"use client";

import { useEffect, useState, useCallback } from "react";

type SiteStatus = {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  productionStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingStatus: "healthy" | "degraded" | "error" | "unknown";
};

type PollResult = {
  ok: boolean;
  mode?: "live" | "mock";
  generatedAt?: string;
  stats?: { healthySites: number; degradedSites: number; errorSites: number; unknownSites?: number };
  sites?: SiteStatus[];
  error?: string;
};

type Props = {
  intervalMs?: number;
};

export default function StatusPoll({ intervalMs = 30_000 }: Props) {
  const [data, setData] = useState<PollResult | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/coolify/status", { cache: "no-store" });
      const json = (await res.json()) as PollResult;
      setData(json);
      setLastUpdated(new Date());
    } catch {
      setData({ ok: false, error: "Network error" });
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs]);

  if (!data) {
    return <p className="card-muted" style={{ margin: 0 }}>Loading live status…</p>;
  }

  if (!data.ok) {
    return <p className="card-muted" style={{ margin: 0, color: "var(--danger, #ef4444)" }}>Status unavailable: {data.error}</p>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <span className={`status-chip ${data.sites?.every((s) => s.status === "healthy") ? "healthy" : "degraded"}`}>
          {data.mode === "live" ? "live" : "mock"}
        </span>
        {lastUpdated && (
          <span className="card-muted" style={{ fontSize: "0.8rem" }}>
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      {data.stats && (
        <div style={{ marginBottom: "0.75rem" }}>
          <p style={{ margin: "0.25rem 0", fontSize: "0.9rem" }}>
            <span style={{ color: "var(--success, #10b981)" }}>●</span> Healthy: <strong>{data.stats.healthySites}</strong>
          </p>
          <p style={{ margin: "0.25rem 0", fontSize: "0.9rem" }}>
            <span style={{ color: "var(--warning, #f59e0b)" }}>●</span> Degraded: <strong>{data.stats.degradedSites}</strong>
          </p>
          <p style={{ margin: "0.25rem 0", fontSize: "0.9rem" }}>
            <span style={{ color: "var(--danger, #ef4444)" }}>●</span> Error: <strong>{data.stats.errorSites}</strong>
          </p>
          {(data.stats.unknownSites ?? 0) > 0 && (
            <p style={{ margin: "0.25rem 0", fontSize: "0.9rem" }}>
              <span style={{ color: "#a8b8ba" }}>●</span> Offline / Unknown: <strong>{data.stats.unknownSites}</strong>
            </p>
          )}
        </div>
      )}

      {data.sites && data.sites.filter((s) => s.status !== "healthy").length > 0 && (
        <div>
          <p className="card-muted" style={{ marginBottom: "0.35rem", fontSize: "0.82rem" }}>Needs attention:</p>
          {data.sites
            .filter((s) => s.status !== "healthy")
            .map((site) => (
              <p key={site.id} style={{ margin: "0.25rem 0", fontSize: "0.9rem" }}>
                <strong>{site.name}</strong>{" "}
                <span className={`status-chip ${site.status}`}>{site.status}</span>
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
