"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SUGGESTED_TLDS, normalizeDomainQuery } from "@/lib/domain-search";
import { btnPrimary, cx, pill } from "@/lib/public-ui";

/**
 * The domain search on the public homepage.
 *
 * ## Why this is not a live-as-you-type search
 *
 * Availability comes from an upstream that allows ONE check every ten seconds
 * for the whole account — not per visitor. A search-as-you-type box would spend
 * the entire budget on one person's keystrokes and lock everyone else out. So:
 *
 * - Checking happens on explicit submit only.
 * - The typed name is the one thing checked.
 * - Other endings are shown with PRICES, which come from an unthrottled
 *   endpoint and cost nothing.
 * - While a check is cooling down the button says so and counts down.
 *
 * ## Nothing is ever reported as available unless it was checked
 *
 * The result is a three-state answer — available, taken, or "could not check"
 * — mirroring the API. A price next to a TLD is a PRICE, never a claim about
 * availability. Showing a green tick for something we never asked about would
 * send someone to a checkout that fails at the registry.
 */

type TldPrice = {
  tld: string;
  registrationDisplay: string;
  transferDisplay: string;
};

type Outcome =
  | { kind: "available"; domain: string; priceDisplay: string; renewalDisplay: string; premium: boolean; sandbox: boolean }
  | { kind: "taken"; domain: string; transferDisplay: string }
  | { kind: "problem"; domain: string; reason: string; message: string; retryAfterSeconds: number | null };

const inputClass =
  "flex-[1_1_260px] min-w-0 h-[52px] px-4 text-base text-text bg-surface " +
  "border border-solid border-border-strong rounded-[10px] outline-none";

const searchButtonClass = cx(btnPrimary, "h-[52px] px-6 text-[15.5px] shrink-0 rounded-[10px]");

export default function DomainSearch({ initialPrices }: { initialPrices: TldPrice[] }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Seconds until another check is worth attempting. Drives every disabled state. */
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const typed = normalizeDomainQuery(query);
  const hasTld = typed.includes(".");

  const check = useCallback(async (domain: string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/domains/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain })
      });
      const payload = await response.json().catch(() => ({}));

      if (payload?.ok && payload.available === true) {
        setOutcome({
          kind: "available",
          domain: payload.domain,
          priceDisplay: payload.priceDisplay ?? "—",
          renewalDisplay: payload.renewalDisplay ?? "—",
          premium: Boolean(payload.premium),
          sandbox: Boolean(payload.sandbox)
        });
        return;
      }
      if (payload?.ok && payload.available === false) {
        setOutcome({
          kind: "taken",
          domain: payload.domain,
          transferDisplay: payload.transferDisplay ?? "—"
        });
        return;
      }

      const retryAfterSeconds =
        typeof payload?.retryAfterSeconds === "number" ? payload.retryAfterSeconds : null;
      if (retryAfterSeconds) setCooldown(retryAfterSeconds);
      setOutcome({
        kind: "problem",
        domain,
        reason: String(payload?.reason ?? "upstream_error"),
        message: String(payload?.message ?? "That check did not go through."),
        retryAfterSeconds
      });
    } catch {
      setOutcome({
        kind: "problem",
        domain,
        reason: "network",
        message: "Could not reach us to run that check. Check your connection and try again.",
        retryAfterSeconds: null
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const onSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (busy || cooldown > 0) return;
      if (!typed) {
        inputRef.current?.focus();
        return;
      }
      // A bare word gets .com appended rather than fanning out over six TLDs,
      // which would be six checks and a full minute of the shared budget.
      void check(hasTld ? typed : `${typed}.com`);
    },
    [busy, check, cooldown, hasTld, typed]
  );

  const prices = useMemo(
    () => initialPrices.filter((entry) => SUGGESTED_TLDS.includes(entry.tld as (typeof SUGGESTED_TLDS)[number])),
    [initialPrices]
  );

  const disabled = busy || cooldown > 0;
  const inert = disabled || !typed;
  const buttonLabel = busy ? "Checking…" : cooldown > 0 ? `Wait ${cooldown}s` : "Search";

  return (
    <div>
      <form onSubmit={onSubmit} className="flex flex-wrap gap-2.5">
        <label htmlFor="domain-search" className="sr-only">
          Search for a domain name
        </label>
        <input
          id="domain-search"
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="yourbusiness.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          className={inputClass}
        />
        <button
          type="submit"
          disabled={inert}
          className={cx(searchButtonClass, inert ? "opacity-60 cursor-default" : "cursor-pointer")}
        >
          {buttonLabel}
        </button>
      </form>

      {typed && !hasTld ? (
        <p className="mt-2 mb-0 text-[13px] text-muted">
          Searching <strong>{typed}.com</strong>. Type a full name to check a different ending.
        </p>
      ) : null}

      {outcome ? <Result outcome={outcome} cooldown={cooldown} /> : null}

      {/* Prices, not availability. Free to show, so they are shown up front. */}
      {prices.length > 0 ? (
        <div className="mt-4">
          <p className="mt-0 mb-2 text-xs font-bold tracking-[0.08em] uppercase text-muted">
            First year, transfers included
          </p>
          <div className="flex flex-wrap gap-2">
            {prices.map((entry) => (
              <span key={entry.tld} className={pill}>
                <strong className="font-semibold">.{entry.tld}</strong>
                <span className="text-muted">{entry.registrationDisplay}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Result({ outcome, cooldown }: { outcome: Outcome; cooldown: number }) {
  const shell = "mt-3.5 px-4 py-3.5 rounded-xl border border-solid shadow-card-sm";

  if (outcome.kind === "available") {
    return (
      <div className={cx(shell, "border-healthy-border bg-[#f7fcf3]")}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="m-0 text-[15.5px] font-semibold text-ink">{outcome.domain} is available</p>
            <p className="mt-[3px] mb-0 text-[13.5px] text-muted">
              {outcome.priceDisplay} for the first year · renews {outcome.renewalDisplay}
              {outcome.premium ? " · premium name" : ""}
            </p>
          </div>
          <Link
            href={`/domains?domain=${encodeURIComponent(outcome.domain)}`}
            className={cx(btnPrimary, "h-10 px-[18px] text-[14.5px] shrink-0")}
          >
            Register it
          </Link>
        </div>
        {outcome.sandbox ? (
          // Visible on purpose. A test-mode result that looks like a real one
          // is how someone ends up thinking they bought a domain.
          <p className="mt-2.5 mb-0 px-2.5 py-[7px] text-[12.5px] text-warn-text bg-warn-bg border border-solid border-warn-border rounded-lg">
            Test mode — this is the registrar&apos;s sandbox. No domain is actually registered and nothing is charged.
          </p>
        ) : null}
      </div>
    );
  }

  if (outcome.kind === "taken") {
    return (
      <div className={cx(shell, "border-border bg-surface")}>
        <p className="m-0 text-[15.5px] font-semibold text-ink">{outcome.domain} is already registered</p>
        <p className="mt-[3px] mb-0 text-[13.5px] text-muted">
          If it is yours, move it here for {outcome.transferDisplay} — that includes a year&apos;s renewal.
        </p>
        <Link
          href={`/domains/transfer?domain=${encodeURIComponent(outcome.domain)}`}
          className="inline-block mt-2.5 text-sm font-semibold text-[#2f5d3a]"
        >
          Transfer {outcome.domain} →
        </Link>
      </div>
    );
  }

  const isBusyReason = outcome.reason === "rate_limited";
  return (
    <div className={cx(shell, isBusyReason ? "border-warn-border bg-[#fffbf2]" : "border-danger-border bg-[#fffafa]")}>
      <p className="m-0 text-[14.5px] font-semibold text-ink">
        {isBusyReason ? "Domain search is busy" : "Could not check that name"}
      </p>
      <p className="mt-[3px] mb-0 text-[13.5px] text-muted">
        {outcome.message}
        {isBusyReason && cooldown > 0 ? ` Ready again in ${cooldown}s.` : ""}
      </p>
      {/* Deliberately no "probably available" guess and no register link: we
          do not know, so we do not imply. */}
    </div>
  );
}
