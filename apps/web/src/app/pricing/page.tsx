import type { Metadata } from "next";
import Link from "next/link";
import {
  HOSTING_TIERS,
  SLA_TIERS,
  PRICING_MATRIX_ROWS,
  PRICING_FAQ,
  type TierPlan
} from "@/lib/public-plans";
import { COMPANY_NAME, CURRENCY_LABEL, contactEmail, currentYear } from "@/lib/public-site";
import { btnPrimary, btnSecondary, card, cx, publicPage } from "@/lib/public-ui";

export const metadata: Metadata = {
  title: "Pricing & Plans | Jongo",
  description:
    "Transparent cloud hosting and managed SLA tiers for WordPress, Next.js, and modern web applications. Fast deployments, nightly offsite backups, and guaranteed SLAs."
};

function PlanCard({ plan }: { plan: TierPlan }) {
  return (
    <article
      className={cx(
        card,
        "p-[26px] relative flex flex-col justify-between",
        plan.featured && "border-2 border-solid border-[#8dc267] shadow-featured"
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
          <span className="text-[2rem] font-bold text-[#14231c]">${plan.monthlyPrice}</span>
          <small className="text-muted text-[0.85rem]"> / month</small>
          <div className="text-[0.78rem] text-emerald-700 font-semibold mt-0.5">
            or ${plan.annualPrice} / yr (Save 2 months)
          </div>
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
          <div className="mt-2 pt-2 border-t border-solid border-[#dde1e1] text-[#1e332a] font-medium">
            <strong>Support:</strong> {plan.supportSla}
            <br />
            <strong>Dev Time:</strong> {plan.devHours}
          </div>
        </div>

        <Link
          href={`/auth/register?plan=${plan.id}`}
          className={cx(
            plan.featured ? btnPrimary : btnSecondary,
            "flex items-center justify-center px-[18px] py-2.5 text-[14.5px] mb-5 w-full text-center"
          )}
        >
          Select {plan.name}
        </Link>

        <ul className="hosting-plan__features text-[0.84rem]">
          {plan.features.map((item) => (
            <li key={item} className="py-1">
              <span aria-hidden className="text-emerald-600 font-bold mr-1.5">✓</span>
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 pt-3 border-t border-dashed border-[#dde1e1] text-[0.75rem] text-muted">
        Overages: {plan.overageRates.bandwidth} bandwidth · {plan.overageRates.storage} SSD · {plan.overageRates.adHocDev} ad-hoc dev
      </div>
    </article>
  );
}

export default function PricingPage() {
  const email = contactEmail();

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
          Transparent Hosting & Managed SLA Tiers
        </h1>
        <p className="hosting-lede max-w-[680px] mx-auto">
          Operator-grade self-hosted infrastructure. Zero surprise overages, included staging environments, 
          human-readable domains (<code className="bg-[#eef1f1] px-1 py-0.5 rounded text-[0.85rem]">[slug].mfts.link</code>), 
          and developer hours included on managed tiers.
        </p>
      </section>

      {/* SECTION 1: TWO HOSTING TIERS */}
      <section className="hosting-section pt-0 pb-10">
        <div className="mb-6">
          <div className="inline-block text-[0.8rem] font-bold uppercase tracking-wider text-[#4f8a2f] bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
            Hosting Tiers · Cloud Infrastructure
          </div>
          <h2 className="hosting-h2 text-left mt-2 mb-1">Standard Cloud Workloads</h2>
          <p className="hosting-body text-left text-muted">
            Engineered for static sites, WordPress, Next.js/React applications, and full-stack projects.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 items-stretch max-w-4xl">
          {HOSTING_TIERS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
      </section>

      {/* SECTION 2: TWO SLA TIERS */}
      <section className="hosting-section pt-0 pb-14">
        <div className="mb-6">
          <div className="inline-block text-[0.8rem] font-bold uppercase tracking-wider text-[#d4af37] bg-amber-50 px-3 py-1 rounded-full border border-amber-200">
            SLA Tiers · Managed Agency & Enterprise
          </div>
          <h2 className="hosting-h2 text-left mt-2 mb-1">Managed Agency & Mission-Critical SLA</h2>
          <p className="hosting-body text-left text-muted">
            For multi-site portfolios, agencies, and high-traffic platforms requiring developer hours, priority response windows, and uptime guarantees.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 items-stretch max-w-4xl">
          {SLA_TIERS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
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

          <div className="pricing-table__scroll mt-8">
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
          <Link href="/contact">Contact</Link>
          <a href="#">Terms</a>
          <a href="#">Privacy</a>
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
        </div>
      </footer>
    </div>
  );
}
