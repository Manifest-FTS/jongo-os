"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  HOSTING_TIERS,
  SLA_TIERS,
  ALL_PLANS,
  PRICING_MATRIX_ROWS,
  PRICING_FAQ,
  type TierPlan,
  type MatrixRow
} from "@/lib/public-plans";
import { COMPANY_NAME, currentYear } from "@/lib/public-site";
import { btnPrimary, btnSecondary, card, cx, publicPage } from "@/lib/public-ui";
import { showErrorToast } from "@/lib/ui/toast";

/**
 * Signed-in visitors skip the registration form and go straight through
 * Checkout for their existing account; signed-out visitors still land on
 * /auth/register?plan=, which starts Checkout right after the account is
 * created (see auth/register/page.tsx).
 */
function PlanSelectButton({
  plan,
  isAnnual,
  className,
  label
}: {
  plan: TierPlan;
  isAnnual: boolean;
  className?: string;
  label?: string;
}) {
  const { data: session, status } = useSession();
  const [pending, setPending] = useState(false);

  const buttonClass = className ?? cx(
    plan.featured ? btnPrimary : btnSecondary,
    "flex items-center justify-center px-[18px] py-2.5 text-[14.5px] mb-5 w-full text-center"
  );
  const text = label ?? `Select ${plan.name}`;

  if (status === "authenticated" && session?.user) {
    return (
      <button
        type="button"
        disabled={pending}
        className={cx(buttonClass, pending && "opacity-70 cursor-not-allowed")}
        onClick={async () => {
          setPending(true);
          try {
            const response = await fetch("/api/billing/checkout", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ planId: plan.id, interval: isAnnual ? "annual" : "monthly" })
            });
            const payload = await response.json();
            if (!response.ok || typeof payload?.url !== "string") {
              showErrorToast(payload?.error || "Could not start checkout. Please try again.");
              setPending(false);
              return;
            }
            window.location.href = payload.url;
          } catch {
            showErrorToast("Could not start checkout. Please try again.");
            setPending(false);
          }
        }}
      >
        {pending ? "Starting checkout…" : text}
      </button>
    );
  }

  return (
    <Link href={`/auth/register?plan=${plan.id}&interval=${isAnnual ? "annual" : "monthly"}`} className={buttonClass}>
      {text}
    </Link>
  );
}

function PlanCard({ plan, isAnnual }: { plan: TierPlan; isAnnual: boolean }) {
  const displayPrice = isAnnual ? Math.round(plan.annualPrice / 12) : plan.monthlyPrice;
  return (
    <article
      className={cx(
        card,
        "p-[26px] relative flex flex-col justify-between",
        // Matches .sg-plan-card.featured in the style guide: accent-strong border + green-tinted shadow.
        plan.featured && "border-2 border-solid border-accent-strong shadow-[0_14px_34px_rgba(127,180,92,0.18)]"
      )}
    >
      {plan.badge ? (
        <span className="hosting-badge">{plan.badge}</span>
      ) : null}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[12px] font-bold uppercase tracking-wider text-[#4f8a2f]">
            {plan.categoryLabel}
          </span>
          {plan.uptimeGuarantee ? (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              {plan.uptimeGuarantee}
            </span>
          ) : null}
        </div>
        <h2 className="hosting-plan__name text-[1.4rem]">{plan.name}</h2>
        <p className="hosting-plan__blurb text-[0.88rem] min-h-[38px]">{plan.blurb}</p>
        <div className="hosting-plan__price my-3">
          <span className="text-[2rem] font-bold text-[#14231c]">${displayPrice}</span>
          <small className="text-muted text-[0.85rem]"> / month</small>
          {isAnnual ? (
            <div className="text-[0.78rem] text-emerald-700 font-semibold mt-0.5">
              Billed annually at ${plan.annualPrice}/yr
            </div>
          ) : (
            <div className="text-[0.78rem] text-muted mt-0.5">
              Billed monthly, no lock-in
            </div>
          )}
        </div>

        {/* Compute Specs Box */}
        <div className="bg-[#f8f9f9] border border-solid border-[#dde1e1] rounded-lg p-3 my-4 text-[0.82rem] leading-relaxed">
          <div className="font-semibold text-[#1e332a] mb-1">Compute & Storage:</div>
          <div className="text-[#4b5556]">
            • {plan.compute.ram} · {plan.compute.vcpu}
            <br />
            • {plan.compute.bandwidth}
            <br />
            • {plan.compute.storage}
          </div>
          <div className="mt-2.5 text-[#1e332a] font-medium">
            <strong>Support:</strong> {plan.supportSla}
            <br />
            <strong>Dev Time:</strong> {plan.devHours}
            {plan.uptimeNote ? (
              <>
                <br />
                <strong>Uptime:</strong> {plan.uptimeNote}
              </>
            ) : null}
          </div>
        </div>

        <PlanSelectButton plan={plan} isAnnual={isAnnual} />

        <ul className="hosting-plan__features text-[0.84rem]">
          {plan.features.map((item) => (
            <li key={item} className="py-1">
              <span aria-hidden className="text-emerald-600 font-bold mr-1.5">✓</span>
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 text-[0.75rem] text-muted">
        Overages: {plan.overageRates.bandwidth} bandwidth · {plan.overageRates.storage} SSD · {plan.overageRates.adHocDev} ad-hoc dev
      </div>
    </article>
  );
}

export default function PricingPage() {
  const [isAnnual, setIsAnnual] = useState<boolean>(true);
  const [mobileSelectedTier, setMobileSelectedTier] = useState<string>("pro");
  const [mobileSearchQuery, setMobileSearchQuery] = useState<string>("");
  const [mobileViewMode, setMobileViewMode] = useState<"dynamic" | "table">("dynamic");

  const currentMobilePlan = useMemo(() => {
    return ALL_PLANS.find((p) => p.id === mobileSelectedTier) || ALL_PLANS[1];
  }, [mobileSelectedTier]);

  const filteredMatrixRows = useMemo(() => {
    if (!mobileSearchQuery.trim()) return PRICING_MATRIX_ROWS;
    const q = mobileSearchQuery.toLowerCase();
    return PRICING_MATRIX_ROWS.filter(
      (r) => r.metric.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
    );
  }, [mobileSearchQuery]);

  const getTierValue = (row: MatrixRow, tierId: string) => {
    switch (tierId) {
      case "starter": return row.starter;
      case "pro": return row.pro;
      case "core-sla": return row.coreSla;
      case "enterprise-sla": return row.enterpriseSla;
      default: return row.pro;
    }
  };

  return (
    <div className={publicPage}>
      <header className="hosting-nav">
        <Link href="/hosting" className="hosting-brand">
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={30} height={30} />
          <span>Jongo</span>
        </Link>
        <div className="hosting-nav__actions">
          <Link href="/style-guide" className="hosting-nav__signin text-[0.88rem] font-semibold text-[#4f8a2f]">
            Style Guide
          </Link>
          <Link href="/contact" className="hosting-nav__signin">
            Contact
          </Link>
          <Link href="/auth/login" className="hosting-nav__signin">
            Sign in
          </Link>
          <Link href="/auth/register" className={cx(btnPrimary, "px-4 py-[9.5px]")}>
            Get started
          </Link>
        </div>
      </header>

      <section className="pricing-head">
        <h1 className="hosting-h1 text-[clamp(1.9rem,1.3rem+2vw,2.75rem)]">
          Transparent Pricing Matrix
        </h1>
        <p className="hosting-lede max-w-[680px] mx-auto">
          Two transparent cloud hosting tiers and two high-assurance managed SLA tiers. All plans include
          unlimited projects, automated staging, wildcard SSL, daily offsite backups, and zero per-seat fees.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <div className="sg-billing-switcher">
            <button
              type="button"
              onClick={() => setIsAnnual(false)}
              aria-pressed={!isAnnual}
              className={cx("sg-billing-btn", !isAnnual && "active")}
            >
              Monthly Billing
            </button>
            <button
              type="button"
              onClick={() => setIsAnnual(true)}
              aria-pressed={isAnnual}
              className={cx("sg-billing-btn", isAnnual && "active")}
            >
              Yearly Billing
            </button>
          </div>
          {isAnnual ? (
            <span className="sg-discount-tag">🎉 Save 2 Months (~20% off annual plans)</span>
          ) : null}
        </div>
      </section>

      {/* SECTION 1: TWO HOSTING TIERS */}
      <section className="hosting-section pt-0 pb-10">
        <div className="mb-6 text-center">
          <div className="inline-block text-[0.8rem] font-bold uppercase tracking-wider text-[#4f8a2f] bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
            Two Cloud Hosting Tiers
          </div>
          <h2 className="hosting-h2 mt-2 mb-1">Standard Cloud Workloads</h2>
          <p className="hosting-body max-w-[620px] mx-auto text-[#4b5556]">
            Engineered for static sites, WordPress, Next.js/React applications, and full-stack projects.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 items-stretch">
          {HOSTING_TIERS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} isAnnual={isAnnual} />
          ))}
        </div>
      </section>

      {/* SECTION 2: TWO SLA TIERS */}
      <section className="hosting-section pt-0 pb-14">
        <div className="mb-6 text-center">
          <div className="inline-block text-[0.8rem] font-bold uppercase tracking-wider text-[#d4af37] bg-amber-50 px-3 py-1 rounded-full border border-amber-200">
            SLA Tiers · Managed Agency & Enterprise
          </div>
          <h2 className="hosting-h2 mt-2 mb-1">Managed Agency & Mission-Critical SLA</h2>
          <p className="hosting-body max-w-[620px] mx-auto text-[#4b5556]">
            For multi-site portfolios, agencies, and high-traffic platforms requiring developer hours, priority response windows, and uptime guarantees.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 items-stretch">
          {SLA_TIERS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} isAnnual={isAnnual} />
          ))}
        </div>
      </section>

      {/* SECTION 3: TRANSPARENT ESCALATION & USAGE MATRIX */}
      <section className="hosting-pricing">
        <div className="hosting-section py-14">
          <h2 className="hosting-h2">Jongo Usage & Escalation Matrix</h2>
          <p className="hosting-sub max-w-[720px] mx-auto">
            Comprehensive side-by-side comparison of compute allocations, support response SLAs, included developer time, and predictable overage rates across all tiers.
          </p>

          {/* DYNAMIC VERCEL-STYLE COMPARISON ON MOBILE (< md screens) */}
          <div className="block md:hidden mt-8">
            <div className="bg-white border border-solid border-[#dde1e1] rounded-2xl p-4 shadow-sm mb-4">
              {/* Mobile View Toggle */}
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-solid border-[#eef1f1]">
                <span className="text-[0.78rem] font-bold uppercase tracking-wider text-muted">Mobile Display:</span>
                <div className="inline-flex rounded-lg border border-solid border-[#dde1e1] p-0.5 bg-[#f8f9f9]">
                  <button
                    onClick={() => setMobileViewMode("dynamic")}
                    className={cx(
                      "px-2.5 py-1 text-[0.75rem] font-semibold rounded-md transition-all",
                      mobileViewMode === "dynamic" ? "bg-[#1e332a] text-white shadow-sm" : "text-[#6c7778]"
                    )}
                  >
                    Tier Selector (Vercel Style)
                  </button>
                  <button
                    onClick={() => setMobileViewMode("table")}
                    className={cx(
                      "px-2.5 py-1 text-[0.75rem] font-semibold rounded-md transition-all",
                      mobileViewMode === "table" ? "bg-[#1e332a] text-white shadow-sm" : "text-[#6c7778]"
                    )}
                  >
                    Full Grid Table
                  </button>
                </div>
              </div>

              {mobileViewMode === "dynamic" ? (
                <div>
                  {/* Search feature input */}
                  <div className="mb-3">
                    <input
                      type="text"
                      placeholder="Search feature or metric (e.g., RAM, SLA, Dev Time)..."
                      value={mobileSearchQuery}
                      onChange={(e) => setMobileSearchQuery(e.target.value)}
                      className="w-full px-3 py-2 text-[0.88rem] rounded-lg border border-solid border-[#dde1e1] bg-[#f8f9f9] text-[#14231c]"
                    />
                  </div>

                  {/* Plan dropdown selector */}
                  <div className="mb-4">
                    <label className="block text-[0.75rem] font-bold text-[#6c7778] uppercase mb-1">
                      Active Comparison Tier:
                    </label>
                    <select
                      value={mobileSelectedTier}
                      onChange={(e) => setMobileSelectedTier(e.target.value)}
                      className="w-full px-3 py-2.5 text-[0.95rem] font-bold rounded-lg border-2 border-solid border-[#7fb45c] bg-white text-[#14231c]"
                    >
                      <option value="starter">Starter Cloud — $45/mo ($450/yr)</option>
                      <option value="pro">Pro Cloud — $75/mo ($750/yr)</option>
                      <option value="core-sla">Core SLA (Agency) — $149/mo ($1,490/yr)</option>
                      <option value="enterprise-sla">Enterprise SLA — $349/mo ($3,490/yr)</option>
                    </select>
                  </div>

                  {/* Tier highlight summary */}
                  <div className="bg-[#f7faf5] border border-solid border-[#a7f3d0] rounded-xl p-3 mb-4">
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[#4f8a2f]">
                          {currentMobilePlan.categoryLabel}
                        </span>
                        <h4 className="text-[1.1rem] font-bold text-[#14231c] m-0">{currentMobilePlan.name}</h4>
                      </div>
                      <div className="text-right">
                        <span className="text-[1.3rem] font-bold text-[#14231c]">${isAnnual ? Math.round(currentMobilePlan.annualPrice / 12) : currentMobilePlan.monthlyPrice}</span>
                        <small className="text-muted block text-[11px]">/month</small>
                        {isAnnual && <small className="text-muted block text-[11px]">Billed ${currentMobilePlan.annualPrice}/yr</small>}
                      </div>
                    </div>
                  </div>

                  {/* Feature list for selected tier */}
                  <div className="divide-y divide-[#eef1f1]">
                    {filteredMatrixRows.map((row) => (
                      <div key={row.metric} className="py-2.5 flex items-center justify-between gap-2 text-[0.85rem]">
                        <div>
                          <strong className="block text-[#14231c]">{row.metric}</strong>
                          <span className="text-[11px] text-muted">{row.category}</span>
                        </div>
                        <div className="text-right font-medium text-[#1e332a]">
                          {getTierValue(row, mobileSelectedTier)}
                        </div>
                      </div>
                    ))}
                  </div>

                  <PlanSelectButton
                    plan={currentMobilePlan}
                    isAnnual={isAnnual}
                    className={cx(btnPrimary, "mt-4 w-full text-center block py-2.5 text-[0.9rem]")}
                    label={`Select ${currentMobilePlan.name} \u2192`}
                  />
                </div>
              ) : (
                /* Full scrolling table for mobile when explicitly chosen */
                <div className="overflow-x-auto">
                  <table className="pricing-table w-full text-left text-[0.78rem]">
                    <thead>
                      <tr>
                        <th scope="col" className="w-28">Metric</th>
                        <th scope="col">Starter</th>
                        <th scope="col" className="is-featured">Pro</th>
                        <th scope="col">Core SLA</th>
                        <th scope="col">Enterprise</th>
                      </tr>
                    </thead>
                    <tbody>
                      {PRICING_MATRIX_ROWS.map((row) => (
                        <tr key={row.metric} className={row.highlight ? "bg-[#fcfdfb] font-medium" : undefined}>
                          <th scope="row" className="font-semibold text-[#14231c] py-2 pr-2">
                            {row.metric}
                          </th>
                          <td className="py-2 px-1.5">{row.starter}</td>
                          <td className="py-2 px-1.5 font-medium bg-[#f7faf5]">{row.pro}</td>
                          <td className="py-2 px-1.5">{row.coreSla}</td>
                          <td className="py-2 px-1.5">{row.enterpriseSla}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* DESKTOP SIDE-BY-SIDE MATRIX TABLE (>= md screens) */}
          <div className="hidden md:block pricing-table__scroll mt-8">
            <table className="pricing-table w-full text-left">
              <thead>
                <tr>
                  <th scope="col" className="w-1/3">
                    <span className="font-bold text-[1rem]">Metric / Service</span>
                  </th>
                  <th scope="col">
                    <span className="pricing-table__plan">Starter Cloud</span>
                    <span className="pricing-table__price">$45/mo</span>
                    <small className="block text-[11px] text-muted">$450/yr</small>
                  </th>
                  <th scope="col" className="is-featured">
                    <span className="pricing-table__plan">Pro Cloud</span>
                    <span className="pricing-table__price">$75/mo</span>
                    <small className="block text-[11px] text-muted">$750/yr</small>
                  </th>
                  <th scope="col">
                    <span className="pricing-table__plan">Core SLA</span>
                    <span className="pricing-table__price">$149/mo</span>
                    <small className="block text-[11px] text-muted">$1,490/yr</small>
                  </th>
                  <th scope="col">
                    <span className="pricing-table__plan">Enterprise SLA</span>
                    <span className="pricing-table__price">$349/mo</span>
                    <small className="block text-[11px] text-muted">$3,490/yr</small>
                  </th>
                </tr>
              </thead>
              <tbody>
                {PRICING_MATRIX_ROWS.map((row) => (
                  <tr key={row.metric} className={row.highlight ? "bg-[#fcfdfc] font-medium" : undefined}>
                    <th scope="row" className="font-semibold text-[#14231c] py-3 pr-3">
                      {row.metric}
                      <span className="block text-[11px] font-normal text-muted">{row.category}</span>
                    </th>
                    <td className="py-3 px-3 text-[0.88rem]">{row.starter}</td>
                    <td className="py-3 px-3 text-[0.88rem] font-medium text-[#1e332a] bg-[#f7faf5]">{row.pro}</td>
                    <td className="py-3 px-3 text-[0.88rem]">{row.coreSla}</td>
                    <td className="py-3 px-3 text-[0.88rem]">{row.enterpriseSla}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="hosting-section pt-16">
        <h2 className="hosting-h2">Frequently Asked Questions</h2>
        <div className="pricing-faq mt-8">
          {PRICING_FAQ.map((item) => (
            <div key={item.q} className={cx(card, "px-[22px] py-5")}>
              <h3 className="contact-route__title font-bold text-[1.05rem] text-[#14231c] mb-2">{item.q}</h3>
              <p className="hosting-body text-[0.92rem] text-[#4b5556] leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="hosting-section pt-0">
        <div className="hosting-closing">
          <div>
            <h2 className="hosting-h2 text-[27px] mb-[9px]">
              Custom Infrastructure or Dedicated Clusters?
            </h2>
            <p className="hosting-body text-[15.5px]">
              Need a multi-node cluster, custom VPC peering, or dedicated compliance isolation? We tailor enterprise hosting architectures for your specific SLA requirements.
            </p>
          </div>
          <Link href="/contact" className={cx(btnPrimary, "px-6 py-[13px] text-[15.5px] shrink-0")}>
            Speak with technical lead →
          </Link>
        </div>
      </section>

      <footer className="hosting-footer">
        <div>
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={22} height={22} />
          <span>© {currentYear()} {COMPANY_NAME}. All rights reserved.</span>
        </div>
        <div className="hosting-footer__links">
          <Link href="/hosting">Hosting</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/style-guide">Style Guide</Link>
          <Link href="/contact">Contact</Link>
        </div>
      </footer>
    </div>
  );
}
