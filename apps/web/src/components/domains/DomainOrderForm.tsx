"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GlobeIcon, LockIcon } from "@/components/JongoIcons";
import { btnPrimary, cx } from "@/lib/public-ui";
import { countryOptions } from "@/lib/countries";

type Operation = "register" | "transfer";

type Quote = {
  domain: string;
  years: number;
  clientDisplay: string;
  admin?: { wholesaleDisplay: string; markupPercent: number; markupDisplay: string };
};

type Availability =
  | { state: "idle" }
  | { state: "checking"; domain: string }
  | { state: "available"; domain: string; priceDisplay: string; renewalDisplay: string; premium: boolean }
  | { state: "taken"; domain: string; transferDisplay: string }
  | { state: "error"; domain: string; message: string };

const TERMS = [1, 2, 3, 5, 10];

/*
 * Layout note: `grid` here always comes with explicit columns. globals.css has
 * its own `.grid` rule with auto-fit columns, and a bare Tailwind `grid` picks
 * that up and scatters the fields (which is what broke the old version).
 */
const inputClass =
  "w-full h-11 px-3.5 rounded-xl border border-solid border-border-strong bg-white text-[15px] text-ink outline-none transition " +
  "placeholder:text-muted/70 focus:border-accent-strong focus:ring-4 focus:ring-accent/25";
const labelClass = "block mb-1.5 text-[13px] font-semibold text-leaf-ink";

function StepCard({ step, title, hint, children, aside }: { step: number; title: string; hint?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="bg-white border border-solid border-border rounded-2xl shadow-card-sm">
      <header className="flex items-start gap-3.5 px-6 pt-5 pb-4 border-0 border-b border-solid border-border">
        <span className="flex items-center justify-center w-7 h-7 shrink-0 rounded-full bg-sidebar text-white text-[13px] font-bold">{step}</span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[16px] font-bold text-ink">{title}</h2>
          {hint ? <p className="mt-0.5 mb-0 text-[13px] text-muted">{hint}</p> : null}
        </div>
        {aside}
      </header>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

function Field({ label, error, children, className }: { label: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className={labelClass}>{label}</span>
      {children}
      {error ? <span className="block mt-1 text-[12.5px] font-medium text-danger-text">{error}</span> : null}
    </label>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
      <path d="m5 10.5 3.2 3.2L15 6.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-solid border-border-strong border-t-leaf-ink animate-spin" aria-hidden />;
}

/**
 * Domain checkout. Prices always come from the server (the browser never
 * names one) and the server quotes again when checkout starts.
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
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastChecked = useRef<string>("");

  const countries = useMemo(() => countryOptions(), []);
  const name = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const looksComplete = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) && !name.endsWith("-");

  // Availability: once typing pauses, and once per name (the search API is
  // rate limited per visitor).
  useEffect(() => {
    if (!looksComplete) {
      setAvailability({ state: "idle" });
      lastChecked.current = "";
      return;
    }
    if (lastChecked.current === name) return;
    const timer = setTimeout(async () => {
      lastChecked.current = name;
      setAvailability({ state: "checking", domain: name });
      try {
        const response = await fetch("/api/domains/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ domain: name })
        });
        const payload = await response.json().catch(() => null);
        if (payload?.ok && payload.available) {
          setAvailability({ state: "available", domain: payload.domain, priceDisplay: payload.priceDisplay, renewalDisplay: payload.renewalDisplay, premium: Boolean(payload.premium) });
        } else if (payload?.ok) {
          setAvailability({ state: "taken", domain: payload.domain, transferDisplay: payload.transferDisplay });
        } else {
          lastChecked.current = "";
          setAvailability({ state: "error", domain: name, message: payload?.message ?? "We could not check that name just now." });
        }
      } catch {
        lastChecked.current = "";
        setAvailability({ state: "error", domain: name, message: "We could not check that name just now." });
      }
    }, 650);
    return () => clearTimeout(timer);
  }, [name, looksComplete]);

  // Price for the chosen operation and term.
  useEffect(() => {
    if (!looksComplete) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ domain: name, op: operation, years: String(operation === "transfer" ? 1 : years) });
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/domains/quote?${params}`).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (!cancelled) setQuote(payload?.ok ? (payload as Quote) : null);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, looksComplete, operation, years]);

  const blocked =
    (operation === "register" && (availability.state === "taken" || (availability.state === "available" && availability.premium))) ||
    (operation === "transfer" && availability.state === "available");
  const canSubmit = Boolean(quote) && Boolean(organizationId) && !blocked && !busy && availability.state !== "checking";
  // Shown in the summary instead of a price for something that can't be bought.
  const blockedReason = !blocked
    ? null
    : operation === "transfer"
      ? "This name isn't registered yet, so there is nothing to transfer."
      : availability.state === "available" && availability.premium
        ? "Premium names are quoted on request."
        : "This name is already registered. If it's yours, transfer it in.";
  const shownPrice = blocked ? "—" : quote ? quote.clientDisplay : "—";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const response = await fetch("/api/domains/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          domain: name,
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

  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setContact((current) => ({ ...current, [key]: event.target.value }));
  const contactInput = (key: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input className={inputClass} value={contact[key] ?? ""} onChange={set(key)} {...props} />
  );

  const termLabel = operation === "transfer" ? "Transfer + 1 year renewal" : `Registration · ${years} year${years === 1 ? "" : "s"}`;

  return (
    <form onSubmit={submit} className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="flex flex-col gap-5 min-w-0 flex-1">
        {/* Step 1: the domain */}
        <StepCard
          step={1}
          title="Choose your domain"
          hint={operation === "register" ? "Search for a name that is free to register." : "Move a domain you already own to Jongo."}
          aside={
            <div role="tablist" aria-label="Order type" className="hidden sm:inline-flex p-1 rounded-xl bg-[#f1f4f2] border border-solid border-border">
              {(["register", "transfer"] as const).map((op) => (
                <button
                  key={op}
                  type="button"
                  role="tab"
                  aria-selected={operation === op}
                  onClick={() => setOperation(op)}
                  className={cx(
                    "px-3.5 py-1.5 rounded-lg text-[13px] font-semibold border-0 cursor-pointer transition",
                    operation === op ? "bg-white text-ink shadow-card-sm" : "bg-transparent text-muted hover:text-ink"
                  )}
                >
                  {op === "register" ? "Register new" : "Transfer in"}
                </button>
              ))}
            </div>
          }
        >
          <div className="flex sm:hidden mb-4 p-1 rounded-xl bg-[#f1f4f2] border border-solid border-border">
            {(["register", "transfer"] as const).map((op) => (
              <button
                key={op}
                type="button"
                onClick={() => setOperation(op)}
                className={cx(
                  "flex-1 py-2 rounded-lg text-[13px] font-semibold border-0 cursor-pointer",
                  operation === op ? "bg-white text-ink shadow-card-sm" : "bg-transparent text-muted"
                )}
              >
                {op === "register" ? "Register new" : "Transfer in"}
              </button>
            ))}
          </div>

          <div className="relative">
            <GlobeIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted pointer-events-none" />
            <input
              className={cx(inputClass, "h-14 pl-12 pr-4 text-[17px] font-semibold rounded-2xl")}
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="yourbusiness.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Domain name"
              required
            />
          </div>

          <AvailabilityLine availability={availability} operation={operation} onSwitch={setOperation} />

          {operation === "register" ? (
            <div className="mt-5">
              <span className={labelClass}>Registration term</span>
              <div className="flex flex-wrap gap-2">
                {TERMS.map((term) => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => setYears(term)}
                    aria-pressed={years === term}
                    className={cx(
                      "min-w-[76px] h-10 px-3 rounded-xl text-[14px] font-semibold border border-solid cursor-pointer transition",
                      years === term ? "bg-[#f3f9ee] border-accent-strong text-leaf-ink ring-2 ring-accent/30" : "bg-white border-border text-ink hover:border-border-strong"
                    )}
                  >
                    {term} {term === 1 ? "year" : "years"}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {organizations.length > 1 ? (
            <div className="mt-5 max-w-[360px]">
              <Field label="Client">
                <select className={inputClass} value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : (
            <p className="mt-5 mb-0 text-[13px] text-muted">
              For <span className="font-semibold text-ink">{organizations[0]?.name}</span>
            </p>
          )}
        </StepCard>

        {/* Step 2: owner or authorization */}
        {operation === "register" ? (
          <StepCard
            step={2}
            title="Domain owner"
            hint="The legal owner of the name. Registries require these details."
            aside={
              <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-healthy-bg border border-solid border-healthy-border text-healthy-text text-[12px] font-semibold">
                <LockIcon className="w-3.5 h-3.5" /> WHOIS privacy on
              </span>
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="First name" error={fieldErrors.firstName}>{contactInput("firstName", { autoComplete: "given-name", required: true })}</Field>
              <Field label="Last name" error={fieldErrors.lastName}>{contactInput("lastName", { autoComplete: "family-name", required: true })}</Field>
              <Field label="Organization (optional)" error={fieldErrors.organization} className="sm:col-span-2">
                {contactInput("organization", { autoComplete: "organization" })}
              </Field>
              <Field label="Email" error={fieldErrors.email}>{contactInput("email", { type: "email", autoComplete: "email", required: true })}</Field>
              <Field label="Phone" error={fieldErrors.phone}>
                {contactInput("phone", { type: "tel", autoComplete: "tel", placeholder: "+1 555 123 4567", required: true })}
              </Field>
            </div>
            <div className="mt-5 pt-5 border-0 border-t border-dashed border-border grid grid-cols-1 sm:grid-cols-6 gap-4">
              <Field label="Street address" error={fieldErrors.address1} className="sm:col-span-6">
                {contactInput("address1", { autoComplete: "address-line1", required: true })}
              </Field>
              <Field label="Apartment, suite (optional)" error={fieldErrors.address2} className="sm:col-span-6">
                {contactInput("address2", { autoComplete: "address-line2" })}
              </Field>
              <Field label="City" error={fieldErrors.city} className="sm:col-span-2">{contactInput("city", { autoComplete: "address-level2", required: true })}</Field>
              <Field label="State / province" error={fieldErrors.stateProvince} className="sm:col-span-2">
                {contactInput("stateProvince", { autoComplete: "address-level1", required: true })}
              </Field>
              <Field label="Postal code" error={fieldErrors.postalCode} className="sm:col-span-2">
                {contactInput("postalCode", { autoComplete: "postal-code", required: true })}
              </Field>
              <Field label="Country" error={fieldErrors.country} className="sm:col-span-6">
                <select className={inputClass} value={contact.country ?? "US"} onChange={set("country")} autoComplete="country">
                  {countries.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </StepCard>
        ) : (
          <StepCard step={2} title="Authorize the transfer" hint="From the registrar the domain is with today.">
            <ol className="m-0 mb-5 p-0 list-none flex flex-col gap-2.5">
              {[
                "Unlock the domain at your current registrar.",
                "Ask them for the authorization code (also called EPP or auth code).",
                "Paste it below. Your site and email keep working during the move."
              ].map((text, index) => (
                <li key={text} className="flex items-start gap-3 text-[14px] text-ink">
                  <span className="flex items-center justify-center w-5 h-5 mt-px shrink-0 rounded-full bg-[#eef4ea] text-leaf-ink text-[11px] font-bold">
                    {index + 1}
                  </span>
                  {text}
                </li>
              ))}
            </ol>
            <Field label="Authorization code" error={fieldErrors.eppCode}>
              <input
                className={cx(inputClass, "font-mono tracking-wide")}
                value={eppCode}
                onChange={(event) => setEppCode(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. 7Kq#x2Lp9!"
                required
              />
            </Field>
            <p className="mt-3 mb-0 text-[12.5px] text-muted">Transfers usually finish within 5 days. A year is added to the domain when it does.</p>
          </StepCard>
        )}
      </div>

      {/* Order summary */}
      <aside className="w-full lg:w-[360px] shrink-0 lg:sticky lg:top-6">
        <div className="bg-white border border-solid border-border rounded-2xl shadow-card-lg overflow-hidden">
          <div className="px-6 pt-5 pb-4 bg-[linear-gradient(160deg,#f7fbf3_0%,#ffffff_70%)] border-0 border-b border-solid border-border">
            <p className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Order summary</p>
            <p className={cx("mt-1.5 mb-0 text-[20px] font-bold break-all", looksComplete ? "text-ink" : "text-muted/60")}>
              {looksComplete ? name : "yourbusiness.com"}
            </p>
          </div>

          <dl className="m-0 px-6 py-4 flex flex-col gap-3 text-[14px]">
            <div className="flex justify-between gap-3">
              <dt className="text-ink">{termLabel}</dt>
              <dd className="m-0 font-semibold text-ink tabular-nums">{shownPrice}</dd>
            </div>
            {[
              ["WHOIS privacy", "Free"],
              ["DNS hosting", "Included"],
              ["Wildcard SSL", "Included"]
            ].map(([item, value]) => (
              <div key={item} className="flex justify-between gap-3">
                <dt className="flex items-center gap-2 text-muted">
                  <CheckIcon className="w-4 h-4 text-accent-strong" />
                  {item}
                </dt>
                <dd className="m-0 text-healthy-text font-semibold">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mx-6 pt-4 pb-1 border-0 border-t border-solid border-border flex items-baseline justify-between">
            <span className="text-[14px] font-semibold text-ink">Due today</span>
            <span className="text-[26px] font-bold text-ink tabular-nums">{shownPrice}</span>
          </div>

          {showWholesale && quote?.admin && !blocked ? (
            <div className="mx-6 mt-3 px-3 py-2.5 rounded-xl border border-dashed border-border-strong bg-[#fafbfa] text-[12.5px] text-muted">
              <span className="font-semibold text-leaf-ink">Admin only</span> · Namecheap {quote.admin.wholesaleDisplay} + {quote.admin.markupPercent}% markup (
              {quote.admin.markupDisplay})
            </div>
          ) : null}

          <div className="px-6 pt-4 pb-6">
            {blockedReason ? (
              <p className="mt-0 mb-3 px-3 py-2.5 rounded-xl bg-warn-bg border border-solid border-warn-border text-warn-text text-[13px]">{blockedReason}</p>
            ) : null}
            {error ? (
              <p className="mt-0 mb-3 px-3 py-2.5 rounded-xl bg-danger-bg border border-solid border-danger-border text-danger-text text-[13px]">{error}</p>
            ) : null}
            <button type="submit" disabled={!canSubmit} className={cx(btnPrimary, "w-full h-12 text-[15.5px] rounded-xl disabled:opacity-50 disabled:cursor-not-allowed")}>
              {busy ? (
                <>
                  <Spinner /> Starting secure checkout…
                </>
              ) : (
                "Continue to payment"
              )}
            </button>
            <p className="mt-3 mb-0 flex items-center justify-center gap-1.5 text-[12.5px] text-muted">
              <LockIcon className="w-3.5 h-3.5" /> Secure checkout by Stripe
            </p>
          </div>

          <div className="px-6 py-4 bg-[#fafbfa] border-0 border-t border-solid border-border">
            <p className="m-0 mb-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">What happens next</p>
            <ol className="m-0 p-0 list-none flex flex-col gap-2 text-[13px] text-ink">
              <li>1. You pay on Stripe&apos;s secure page.</li>
              <li>2. {operation === "register" ? "We register the name, usually within a minute." : "We start the transfer with the registry."}</li>
              <li>3. DNS and SSL are set up for you automatically.</li>
            </ol>
            <p className="mt-3 mb-0 text-[12px] text-muted">If the registrar can&apos;t complete the order, you are refunded automatically.</p>
          </div>
        </div>
      </aside>
    </form>
  );
}

function AvailabilityLine({
  availability,
  operation,
  onSwitch
}: {
  availability: Availability;
  operation: Operation;
  onSwitch: (operation: Operation) => void;
}) {
  const base = "mt-3 flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl text-[13.5px] leading-snug border border-solid";
  const tick = (
    <span className="flex items-center justify-center w-5 h-5 shrink-0 rounded-full bg-accent-strong text-white">
      <CheckIcon className="w-3.5 h-3.5" />
    </span>
  );

  if (availability.state === "idle") {
    return <p className="mt-2.5 mb-0 text-[13px] text-muted">Include the ending, like .com, .org or .co.uk.</p>;
  }
  if (availability.state === "checking") {
    return (
      <div className={cx(base, "bg-[#fafbfa] border-border text-muted")}>
        <Spinner /> Checking {availability.domain}…
      </div>
    );
  }
  if (availability.state === "error") {
    return <div className={cx(base, "bg-warn-bg border-warn-border text-warn-text")}>{availability.message}</div>;
  }

  if (availability.state === "available") {
    if (availability.premium) {
      return (
        <div className={cx(base, "bg-warn-bg border-warn-border text-warn-text")}>
          <span>
            <strong>{availability.domain}</strong> is a premium name priced by the registry.{" "}
            <a href={`/contact?subject=${encodeURIComponent(`Premium domain ${availability.domain}`)}`} className="font-semibold underline">
              Ask for a quote
            </a>
          </span>
        </div>
      );
    }
    if (operation === "transfer") {
      return (
        <div className={cx(base, "bg-warn-bg border-warn-border text-warn-text")}>
          <span>
            <strong>{availability.domain}</strong> is not registered anywhere yet, so there is nothing to transfer.{" "}
            <button type="button" onClick={() => onSwitch("register")} className="font-semibold underline bg-transparent border-0 p-0 cursor-pointer text-inherit">
              Register it instead
            </button>
          </span>
        </div>
      );
    }
    return (
      <div className={cx(base, "bg-healthy-bg border-healthy-border text-healthy-text")}>
        {tick}
        <span>
          <strong>{availability.domain}</strong> is available · renews at {availability.renewalDisplay}/yr
        </span>
      </div>
    );
  }

  // Taken.
  if (operation === "register") {
    return (
      <div className={cx(base, "bg-[#fafbfa] border-border text-ink")}>
        <span>
          <strong>{availability.domain}</strong> is already registered.{" "}
          <button type="button" onClick={() => onSwitch("transfer")} className="font-semibold text-leaf-ink underline bg-transparent border-0 p-0 cursor-pointer">
            Own it? Transfer it in
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className={cx(base, "bg-healthy-bg border-healthy-border text-healthy-text")}>
      {tick}
      <span>
        <strong>{availability.domain}</strong> can be transferred · {availability.transferDisplay} includes a year&apos;s renewal
      </span>
    </div>
  );
}
