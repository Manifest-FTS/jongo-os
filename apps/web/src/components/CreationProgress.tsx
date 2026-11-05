"use client";

import { useEffect, useState } from "react";

export type CreationStep = { id: string; label: string; status: "pending" | "active" | "done" | "skipped" | "failed"; detail?: string };

/**
 * POST with live progress: asks the server to stream each step
 * (lib/progress.ts) and calls onStep as each one starts or finishes. Resolves
 * with the final status and body, the same as a normal JSON request. If the
 * server or a proxy doesn't stream, everything simply arrives at the end.
 */
export async function postWithProgress(
  url: string,
  body: unknown,
  onStep: (step: { id: string; label: string; status: CreationStep["status"]; detail?: string }) => void
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body)
  });
  if (!(response.headers.get("content-type") ?? "").includes("ndjson") || !response.body) {
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { status: number; body: any } | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const event = JSON.parse(line);
          if (event.type === "step") onStep(event);
          else if (event.type === "result") result = { status: event.status, body: event.body };
        } catch {
          // ignore a malformed line
        }
      }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  return result ?? { status: 502, body: { error: "The connection closed before the app was confirmed. Check the app list before trying again." } };
}

/** Merge a reported step into the list: update it in place, or add it. */
export function applyStep(steps: CreationStep[], step: { id: string; label: string; status: CreationStep["status"]; detail?: string }): CreationStep[] {
  const index = steps.findIndex((existing) => existing.id === step.id);
  if (index < 0) return [...steps, step];
  return steps.map((existing, i) => (i === index ? { ...existing, ...step } : existing));
}

function Icon({ status }: { status: CreationStep["status"] }) {
  const base = { width: 18, height: 18, flex: "0 0 18px", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 999, fontSize: 11, fontWeight: 700 } as const;
  if (status === "active") return <span className="loader__spinner" style={{ width: 16, height: 16, flex: "0 0 16px", margin: 1 }} aria-hidden="true" />;
  if (status === "done") return <span style={{ ...base, background: "var(--accent, #9ec877)", color: "#1b2a10" }} aria-hidden="true">✓</span>;
  if (status === "failed") return <span style={{ ...base, background: "#f3d2cf", color: "#8c1d18" }} aria-hidden="true">!</span>;
  if (status === "skipped") return <span style={{ ...base, border: "1.5px solid var(--border, #ddd)", color: "var(--muted)" }} aria-hidden="true">–</span>;
  return <span style={{ ...base, border: "1.5px solid var(--border, #ddd)" }} aria-hidden="true" />;
}

const STATUS_TEXT: Record<CreationStep["status"], string> = {
  pending: "waiting",
  active: "in progress",
  done: "done",
  skipped: "skipped",
  failed: "didn't finish"
};

/** The checklist shown while an app is being created. */
export default function CreationProgress({ title, steps, startedAt, note, running = true }: { title: string; steps: CreationStep[]; startedAt: number; note?: string; running?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="card" style={{ marginBottom: "1rem", display: "grid", gap: "0.9rem" }} aria-live="polite" aria-busy={running}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
        <h3 className="card-title" style={{ margin: 0 }}>{title}</h3>
        <span className="card-muted" style={{ fontVariantNumeric: "tabular-nums" }}>{elapsed}</span>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.6rem" }}>
        {steps.map((step) => (
          <li key={step.id} style={{ display: "flex", gap: "0.65rem", alignItems: "flex-start" }}>
            <Icon status={step.status} />
            <span style={{ display: "grid", gap: "0.15rem" }}>
              <span style={{ fontSize: "0.9rem", color: step.status === "pending" ? "var(--muted)" : "var(--text)", fontWeight: step.status === "active" ? 600 : 400 }}>
                {step.label}
                <span className="sr-only"> — {STATUS_TEXT[step.status]}</span>
              </span>
              {step.detail ? <span className="card-muted" style={{ fontSize: "0.8rem" }}>{step.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {note === "" ? null : <p className="card-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
        {note ?? "This usually takes under a minute. You can leave this page; the app keeps being created and appears in your app list."}
      </p>}
    </div>
  );
}
