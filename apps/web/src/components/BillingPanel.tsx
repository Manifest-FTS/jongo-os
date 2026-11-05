"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Status = {
  paid: boolean;
  planId: string | null;
  planName: string | null;
  interval: string | null;
  status: string | null;
  currentPeriodEnd: string | null;
};

const STATUS_TEXT: Record<string, string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Payment failed — retrying",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Waiting for payment",
  incomplete_expired: "Payment not completed"
};

/**
 * The account's plan. Straight after Checkout the subscription may not be
 * recorded yet (Stripe confirms it by webhook a moment later), so it checks
 * again for up to half a minute and says it's confirming meanwhile.
 */
export default function BillingPanel({ justPaid }: { justPaid: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [confirming, setConfirming] = useState(justPaid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const load = async () => {
      const res = await fetch("/api/billing/status", { cache: "no-store" }).catch(() => null);
      const data: Status | null = res?.ok ? await res.json().catch(() => null) : null;
      if (cancelled) return;
      if (data) setStatus(data);
      tries += 1;
      if (justPaid && !data?.paid && tries < 15) {
        setTimeout(load, 2000);
      } else {
        setConfirming(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [justPaid]);

  async function manage() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/billing/portal", { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    if (typeof data?.url === "string") {
      window.location.href = data.url;
      return;
    }
    setBusy(false);
    setError(data?.error ?? "Billing management isn't available right now.");
  }

  if (!status) {
    return (
      <div className="card" style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <span className="loader__spinner" style={{ width: 18, height: 18 }} aria-hidden="true" />
        <span className="card-muted">Loading your plan…</span>
      </div>
    );
  }

  const renews = status.currentPeriodEnd ? new Date(status.currentPeriodEnd).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {justPaid ? (
        <div className={`hosting-banner${status.paid ? " hosting-banner--ok" : ""}`} role="status">
          {status.paid ? (
            <span><strong>Payment confirmed.</strong> You can add apps now.</span>
          ) : confirming ? (
            <span style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
              <span className="loader__spinner" style={{ width: 16, height: 16 }} aria-hidden="true" />
              Confirming your payment with Stripe…
            </span>
          ) : (
            <span>Stripe hasn&apos;t confirmed the payment yet. This page updates when it does; refresh in a minute.</span>
          )}
        </div>
      ) : null}

      <div className="card" style={{ display: "grid", gap: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: "0.25rem" }}>
            <span className="card-muted" style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Current plan</span>
            <span style={{ fontSize: "1.35rem", fontWeight: 700 }}>{status.planName ?? "No plan yet"}</span>
            {status.planName ? (
              <span className="card-muted">
                {status.interval === "annual" ? "Billed yearly" : "Billed monthly"}
                {renews ? ` · ${status.status === "canceled" ? "ended" : "renews"} ${renews}` : ""}
              </span>
            ) : (
              <span className="card-muted">Choose a plan to start hosting apps.</span>
            )}
          </div>
          {status.status ? (
            <span className={`status-chip ${status.paid ? "healthy" : status.status === "past_due" ? "degraded" : "unknown"}`}>
              {STATUS_TEXT[status.status] ?? status.status}
            </span>
          ) : null}
        </div>

        <div className="form-row" style={{ flexWrap: "wrap" }}>
          {status.planName && status.status !== "canceled" ? (
            <button type="button" className="btn" disabled={busy} onClick={manage}>
              {busy ? "Opening…" : status.status === "past_due" ? "Update payment method" : "Manage billing"}
            </button>
          ) : (
            <Link href="/pricing" className="btn">Choose a plan</Link>
          )}
          {status.planName ? <Link href="/pricing" className="btn btn-secondary">Compare plans</Link> : null}
        </div>
        {status.planName ? (
          <p className="card-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
            Change plan, update your card, download invoices or cancel in Stripe&apos;s secure billing portal.
          </p>
        ) : null}
        {error ? <p className="auth-error" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      </div>
    </div>
  );
}
