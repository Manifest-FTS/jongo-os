"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

/**
 * Shows which plan brought someone here from /hosting.
 *
 * Its own component behind a Suspense boundary because `useSearchParams` opts
 * the whole subtree out of prerendering — the same arrangement the login page
 * already uses. Keeping it separate leaves the registration form statically
 * rendered.
 *
 * It only DISPLAYS the choice: the registration API stores an account, not a
 * subscription, so nothing here implies the plan has been recorded. Showing it
 * is what stops the choice being silently dropped between the two pages.
 */

const PLAN_LABELS: Record<string, string> = {
  seed: "Seed",
  growth: "Growth",
  summit: "Summit"
};

export default function SelectedPlanNotice() {
  const searchParams = useSearchParams();
  const plan = (searchParams?.get("plan") ?? "").toLowerCase();
  const label = PLAN_LABELS[plan];

  if (!label) {
    return null;
  }

  return (
    <p className="auth-plan-notice">
      Signing up for the <strong>{label}</strong> plan.{" "}
      <Link href="/hosting#pricing" className="auth-inline-link">
        Change
      </Link>
    </p>
  );
}
