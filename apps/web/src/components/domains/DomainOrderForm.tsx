"use client";

import { useCallback, useEffect, useState } from "react";

type Operation = "register" | "transfer";

type Quote = {
  domain: string;
  years: number;
  clientDisplay: string;
  admin?: { wholesaleDisplay: string; markupPercent: number; markupDisplay: string };
};

const CONTACT_FIELDS: Array<{ key: string; label: string; required: boolean; placeholder?: string; wide?: boolean }> = [
  { key: "firstName", label: "First name", required: true },
  { key: "lastName", label: "Last name", required: true },
  { key: "organization", label: "Organization (optional)", required: false, wide: true },
  { key: "address1", label: "Street address", required: true, wide: true },
  { key: "address2", label: "Address line 2 (optional)", required: false, wide: true },
  { key: "city", label: "City", required: true },
  { key: "stateProvince", label: "State / province", required: true },
  { key: "postalCode", label: "Postal code", required: true },
  { key: "country", label: "Country code", required: true, placeholder: "US" },
  { key: "phone", label: "Phone", required: true, placeholder: "+1 555 123 4567" },
  { key: "email", label: "Email", required: true }
];

/**
 * Order form. The price shown is fetched from the server (the browser never
 * names a price), and the server quotes again when checkout starts.
 */
export default function DomainOrderForm({
  organizations,
  initialDomain,
  initialOperation,
  defaultEmail,
  showWholesale
}: {
  organizations: Array<{ id: string; name: string }>;
  initialDomain: string;
  initialOperation: Operation;
  defaultEmail: string;
  showWholesale: boolean;
}) {
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "");
  const [domain, setDomain] = useState(initialDomain);
  const [operation, setOperation] = useState<Operation>(initialOperation);
  const [years, setYears] = useState(1);
  const [eppCode, setEppCode] = useState("");
  const [contact, setContact] = useState<Record<string, string>>({ email: defaultEmail, country: "US" });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadQuote = useCallback(async () => {
    const name = domain.trim();
    if (!name.includes(".")) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const params = new URLSearchParams({ domain: name, op: operation, years: String(years) });
    const response = await fetch(`/api/domains/quote?${params}`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (payload?.ok) {
      setQuote(payload as Quote);
      setQuoteError(null);
    } else {
      setQuote(null);
      setQuoteError(payload?.message ?? "Could not get a price right now.");
    }
  }, [domain, operation, years]);

  useEffect(() => {
    const timer = setTimeout(() => void loadQuote(), 450);
    return () => clearTimeout(timer);
  }, [loadQuote]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const response = await fetch("/api/domains/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          domain: domain.trim(),
          operation,
          years: operation === "transfer" ? 1 : years,
          ...(operation === "register" ? { contact } : { eppCode })
        })
      });
      const payload = await response.json().catch(() => null);
      if (payload?.ok && payload.url) {
        window.location.assign(payload.url);
        return;
      }
      setError(payload?.message ?? `Checkout could not start (HTTP ${response.status}).`);
      setFieldErrors(payload?.fieldErrors ?? {});
    } catch {
      setError("Lost the connection. Nothing was charged; try again.");
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (key: string) =>
    fieldErrors[key] ? <p className="form-error mt-1 mb-0 text-[0.78rem]">{fieldErrors[key]}</p> : null;

  return (
    <form onSubmit={submit} className="card grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="form-label">Client</span>
          <select className="form-input" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="form-label">Domain</span>
          <input
            className="form-input"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.org"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-4 items-end">
        <fieldset className="m-0 p-0 border-0 flex gap-4">
          {(["register", "transfer"] as const).map((op) => (
            <label key={op} className="flex items-center gap-2 text-[0.9rem]">
              <input type="radio" name="operation" checked={operation === op} onChange={() => setOperation(op)} />
              {op === "register" ? "Register a new domain" : "Transfer one I own"}
            </label>
          ))}
        </fieldset>
        {operation === "register" ? (
          <label className="grid gap-1">
            <span className="form-label">Years</span>
            <select className="form-input w-[110px]" value={years} onChange={(e) => setYears(Number(e.target.value))}>
              {[1, 2, 3, 5, 10].map((y) => (
                <option key={y} value={y}>
                  {y} year{y === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="px-3.5 py-3 rounded-lg border border-solid border-border bg-bg">
        {quote ? (
          <p className="m-0 text-[0.95rem]">
            <strong>{quote.clientDisplay}</strong>{" "}
            <span className="text-muted">
              {operation === "transfer" ? "for the transfer, including a year's renewal" : `for ${quote.years} year${quote.years === 1 ? "" : "s"}`} · WHOIS privacy
              included
            </span>
            {showWholesale && quote.admin ? (
              <span className="block mt-1 text-[0.8rem] text-muted">
                Admin only: Namecheap {quote.admin.wholesaleDisplay} + {quote.admin.markupPercent}% markup ({quote.admin.markupDisplay})
              </span>
            ) : null}
          </p>
        ) : (
          <p className="m-0 text-[0.88rem] text-muted">{quoteError ?? "Enter a domain to see the price."}</p>
        )}
      </div>

      {operation === "register" ? (
        <div className="grid gap-3">
          <div>
            <p className="m-0 font-semibold text-[0.95rem]">Owner details</p>
            <p className="mt-1 mb-0 text-[0.82rem] text-muted">
              The client is the legal owner of the domain. WHOIS privacy keeps these details out of public lookups.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {CONTACT_FIELDS.map((field) => (
              <label key={field.key} className={`grid gap-1 ${field.wide ? "sm:col-span-2" : ""}`}>
                <span className="form-label">{field.label}</span>
                <input
                  className="form-input"
                  value={contact[field.key] ?? ""}
                  placeholder={field.placeholder}
                  required={field.required}
                  onChange={(e) => setContact((current) => ({ ...current, [field.key]: e.target.value }))}
                />
                {fieldError(field.key)}
              </label>
            ))}
          </div>
        </div>
      ) : (
        <label className="grid gap-1">
          <span className="form-label">Authorization (EPP) code</span>
          <input className="form-input" value={eppCode} onChange={(e) => setEppCode(e.target.value)} autoComplete="off" spellCheck={false} required />
          <span className="form-help">
            From your current registrar. Unlock the domain there first. The transfer takes up to 5 days once it starts.
          </span>
          {fieldError("eppCode")}
        </label>
      )}

      {error ? <p className="form-error m-0">{error}</p> : null}

      <div className="flex items-center gap-3 flex-wrap">
        <button type="submit" className="btn" disabled={busy || !quote || !organizationId}>
          {busy ? "Starting checkout…" : quote ? `Continue to payment · ${quote.clientDisplay}` : "Continue to payment"}
        </button>
        <span className="text-[0.8rem] text-muted">Paid securely through Stripe. If the registrar refuses the order, you are refunded automatically.</span>
      </div>
    </form>
  );
}
