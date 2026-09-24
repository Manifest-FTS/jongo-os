"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ALL_PLANS } from "@/lib/public-plans";

/**
 * Shows which plan — or which domain — brought someone here.
 *
 * Its own component behind a Suspense boundary because `useSearchParams` opts
 * the whole subtree out of prerendering — the same arrangement the login page
 * already uses. Keeping it separate leaves the registration form statically
 * rendered.
 *
 * Registration itself only creates the account; the register page starts
 * Stripe Checkout for `?plan=` right after (see api/billing/checkout), so this
 * is a preview of what happens next, not a record of anything already booked.
 *
 * The same goes for `?domain=`, carried from the domain search. A domain is
 * NOT reserved by arriving here — nothing is held until an order goes through
 * — so the notice says so in as many words. The alternative was a "claim it"
 * button that led to a form which forgot the domain entirely, which is the
 * kind of quiet dead end this component exists to prevent.
 */

/** Same shape as the API accepts, so a junk query string renders nothing. */
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{2,63})+$/;

export default function SelectedPlanNotice() {
  const searchParams = useSearchParams();
  const plan = (searchParams?.get("plan") ?? "").toLowerCase();
  const label = ALL_PLANS.find((p) => p.id === plan)?.name;

  const domainParam = (searchParams?.get("domain") ?? "").trim().toLowerCase();
  const domain = DOMAIN_PATTERN.test(domainParam) ? domainParam : "";

  if (!label && !domain) {
    return null;
  }

  return (
    <>
      {label ? (
        <p className="auth-plan-notice">
          Signing up for the <strong>{label}</strong> plan.{" "}
          <Link href="/pricing" className="auth-inline-link">
            Change
          </Link>
        </p>
      ) : null}
      {domain ? (
        <p className="auth-plan-notice">
          You were looking at <strong>{domain}</strong>. It is not reserved yet — create the
          account and we will register it with you.{" "}
          <Link href="/domains" className="auth-inline-link">
            Search again
          </Link>
        </p>
      ) : null}
    </>
  );
}

