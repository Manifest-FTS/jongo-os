"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Continue from a chosen plan straight to Stripe Checkout. Used after signup
 * and from any "choose a plan" link, so picking a plan always ends at payment.
 */
export default function BillingStartPage() {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function start() {
    setError(null);
    const params = new URLSearchParams(window.location.search);
    const planId = params.get("plan") ?? "";
    const interval = params.get("interval") === "annual" ? "annual" : "monthly";
    if (!planId) {
      window.location.href = "/pricing";
      return;
    }
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, interval })
    }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    if (res?.status === 401) {
      window.location.href = `/auth/login?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    if (typeof data?.url === "string") {
      window.location.href = data.url; // Stripe Checkout, or Billing if already on a plan
      return;
    }
    setError(data?.error ?? "Checkout couldn't be started. Try again.");
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, []);

  return (
    <div className="page-stack" style={{ maxWidth: "32rem", margin: "3rem auto" }}>
      <div className="card" style={{ display: "grid", gap: "0.85rem", justifyItems: "center", textAlign: "center", padding: "2rem 1.5rem" }}>
        {error ? (
          <>
            <h1 style={{ margin: 0, fontSize: "1.2rem" }}>Checkout didn&apos;t start</h1>
            <p className="card-muted" style={{ margin: 0 }}>{error}</p>
            <div className="form-row" style={{ justifyContent: "center" }}>
              <button type="button" className="btn" onClick={() => void start()}>Try again</button>
              <Link href="/pricing" className="btn btn-secondary">Back to plans</Link>
            </div>
          </>
        ) : (
          <>
            <span className="loader__spinner" aria-hidden="true" />
            <h1 style={{ margin: 0, fontSize: "1.2rem" }}>Taking you to secure checkout…</h1>
            <p className="card-muted" style={{ margin: 0 }}>Payment is handled by Stripe. Your apps can go live as soon as it&apos;s confirmed.</p>
          </>
        )}
      </div>
    </div>
  );
}
