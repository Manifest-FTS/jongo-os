"use client";

import { useCallback, useEffect, useState } from "react";
import { formatBytes, formatCores, formatRate } from "@/lib/usage-format";

/**
 * What is running right now: two host readings two seconds apart, via
 * /api/usage/live (cached server-side for 20s and scoped to the viewer).
 *
 * Polls every 30 seconds only while the tab is visible, and holds the previous
 * reading while refreshing so the numbers do not flash.
 */

type LiveSubject = {
  siteId: string | null;
  label: string;
  kind: "app" | "infra" | "unmapped";
  cpuCores: number;
  memoryBytes: number;
  memoryLimitBytes: number | null;
  egressBytesPerSec: number;
  containers: number;
};

type LivePayload = {
  ok: boolean;
  takenAt?: number;
  hostCpuCores?: number;
  hostMemTotalBytes?: number;
  subjects?: LiveSubject[];
  error?: string;
};

export default function UsageLivePanel({ siteId, limit = 10 }: { siteId?: string; limit?: number }) {
  const [data, setData] = useState<LivePayload | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/live${siteId ? `?siteId=${encodeURIComponent(siteId)}` : ""}`, { cache: "no-store" });
      setData((await res.json().catch(() => ({ ok: false, error: "Unreadable response." }))) as LivePayload);
    } catch {
      setData({ ok: false, error: "Could not reach the server." });
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const subjects = [...(data?.subjects ?? [])].sort((a, b) => b.cpuCores - a.cpuCores || b.memoryBytes - a.memoryBytes);
  const single = siteId ? subjects[0] : undefined;
  const updated = data?.takenAt ? new Date(data.takenAt * 1000).toLocaleTimeString() : null;

  return (
    <article className={`card transition-opacity ${loading && data ? "opacity-70" : ""}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="card-title m-0">Live now</h3>
          <p className="card-muted mt-1 mb-0 text-[0.85rem]">
            {updated ? `Measured at ${updated} · refreshes every 30s` : loading ? "Taking a reading…" : "—"}
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>

      {data && !data.ok ? (
        <p className="card-muted mt-3 mb-0">{data.error ?? "Live readings are unavailable right now."}</p>
      ) : null}

      {siteId && data?.ok ? (
        single ? (
          <div className="grid grid-cols-3 gap-3 mt-4">
            <div>
              <p className="metric-label m-0">CPU</p>
              <p className="mt-1 mb-0 text-[1.25rem] font-bold text-metric">{formatCores(single.cpuCores)}</p>
            </div>
            <div>
              <p className="metric-label m-0">Memory</p>
              <p className="mt-1 mb-0 text-[1.25rem] font-bold text-metric">{formatBytes(single.memoryBytes)}</p>
              {single.memoryLimitBytes ? (
                <p className="mt-0.5 mb-0 text-[0.8rem] text-muted">limit {formatBytes(single.memoryLimitBytes)}</p>
              ) : null}
            </div>
            <div>
              <p className="metric-label m-0">Egress</p>
              <p className="mt-1 mb-0 text-[1.25rem] font-bold text-metric">{formatRate(single.egressBytesPerSec)}</p>
            </div>
          </div>
        ) : (
          <p className="card-muted mt-3 mb-0">No running containers for this app right now.</p>
        )
      ) : null}

      {!siteId && data?.ok ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[0.86rem] tabular-nums !table">
            <thead>
              <tr className="text-left text-muted">
                <th className="font-semibold py-1.5 pr-3">App</th>
                <th className="font-semibold py-1.5 pr-3 text-right">CPU</th>
                <th className="font-semibold py-1.5 pr-3 text-right">Memory</th>
                <th className="font-semibold py-1.5 text-right">Egress</th>
              </tr>
            </thead>
            <tbody>
              {subjects.slice(0, limit).map((s) => (
                <tr key={`${s.kind}:${s.siteId ?? s.label}`} className="border-0 border-t border-solid border-border">
                  <td className="py-1.5 pr-3">
                    {s.label}
                    {s.kind !== "app" ? (
                      <span className="ml-2 text-[0.75rem] text-muted">{s.kind === "infra" ? "platform" : "no Jongo app"}</span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{formatCores(s.cpuCores)}</td>
                  <td className="py-1.5 pr-3 text-right">{formatBytes(s.memoryBytes)}</td>
                  <td className="py-1.5 text-right">{formatRate(s.egressBytesPerSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.hostCpuCores ? (
            <p className="card-muted mt-2 mb-0 text-[0.8rem]">
              Server: {subjects.reduce((a, s) => a + s.cpuCores, 0).toFixed(2)} of {data.hostCpuCores} cores busy ·{" "}
              {formatBytes(subjects.reduce((a, s) => a + s.memoryBytes, 0))} of {formatBytes(data.hostMemTotalBytes ?? 0)} memory in use
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
