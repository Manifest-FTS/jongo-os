import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import { ALL_PLANS, PRICING_FAQ } from "@/lib/public-plans";
import { breadcrumbJsonLd, faqJsonLd, jsonLdGraph, pageMetadata, plansJsonLd } from "@/lib/seo";

// The pricing page is a client component (billing toggle, checkout), which
// cannot export metadata; its title, description and structured data live here.
// Prices come from the plan data, so the search snippet cannot go stale.
const cheapest = Math.min(...ALL_PLANS.map((plan) => plan.monthlyPrice));
const planList = ALL_PLANS.map((plan) => `${plan.name} $${plan.monthlyPrice}/mo`).join(", ");

export const metadata: Metadata = pageMetadata({
  path: "/pricing",
  title: `Pricing: hosting and managed plans from $${cheapest}/month`,
  description: `Four plans: ${planList}. Two months free when you pay yearly, unlimited sites and staging, no per-seat fees, and published rates for extra usage.`
});

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JsonLd data={jsonLdGraph(breadcrumbJsonLd([{ name: "Pricing", path: "/pricing" }]), plansJsonLd(), faqJsonLd(PRICING_FAQ, "/pricing"))} />
      {children}
    </>
  );
}
