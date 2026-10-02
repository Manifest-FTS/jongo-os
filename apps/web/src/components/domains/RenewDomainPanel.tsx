"use client";

import { useEffect, useState } from "react";

export default function RenewDomainPanel({ domain, organizationId }: { domain: string; organizationId: string }) {
  const [years, setYears] = useState(1);
  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ domain, op: "renew", years: String(years) });
    fetch(`/api/domains/quote?${params}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setPrice(payload?.ok ? payload.clientDisplay : null);
      })
      .catch(() => !cancelled && setPrice(null));
    return () => {
      cancelled = true;
    };
  }, [domain, years]);

  async function renew() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/domains/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, domain, operation: "renew", years })
      });
      const payload = await response.json().catch(() => null);
      if (payload?.ok && payload.url) {
        window.location.assign(payload.url);
        return;
      }
      setError(payload?.message ?? `Could not start the renewal (HTTP ${response.status}).`);
    } catch {
      setError("Lost the connection. Nothing was charged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card flex flex-wrap items-end gap-3">
      <div className="mr-auto">
        <h3 className="card-title m-0">Renew</h3>
        <p className="card-muted mt-1 mb-0 text-[0.84rem]">Adds time on top of the current renewal date.</p>
      </div>
      <label className="grid gap-1">
        <span className="form-label">Years</span>
        <select className="form-input w-[110px]" value={years} onChange={(e) => setYears(Number(e.target.value))}>
          {[1, 2, 3, 5].map((y) => (
            <option key={y} value={y}>
              {y} year{y === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn" onClick={renew} disabled={busy || !price}>
        {busy ? "Starting checkout…" : price ? `Renew · ${price}` : "Renew"}
      </button>
      {error ? <p className="form-error basis-full m-0">{error}</p> : null}
    </article>
  );
}
