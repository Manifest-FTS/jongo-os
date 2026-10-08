/**
 * Search and AI-assistant metadata for the public site, in one place.
 *
 * Everything here is generated from the same data the pages render
 * (lib/public-plans.ts), so a price in a search snippet, in structured data or
 * in llms.txt can never disagree with the page it describes.
 *
 * The canonical host is PUBLIC_SITE_URL (default https://jongo.app), not the
 * request host: the same app also answers on www.jongo.app and os.jongo.app,
 * and every copy points search engines at the one canonical URL.
 */

import type { Metadata } from "next";
import { ALL_PLANS, type TierPlan } from "@/lib/public-plans";
import { contactEmail } from "@/lib/public-site";

export const SITE_URL = (process.env.PUBLIC_SITE_URL || "https://jongo.app").trim().replace(/\/+$/, "");
export const SITE_NAME = "Jongo";

export const SITE_TAGLINE = "Managed hosting and domains for WordPress, Next.js, Nuxt and Node";

export const SITE_DESCRIPTION =
  "Managed hosting for WordPress, Next.js, Nuxt and Node sites, with domain registration and transfers, nightly offsite backups, one-click staging and free migration. Plans from $45 a month.";

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The public, indexable pages. Drives the sitemap and the llms.txt link list. */
export type PublicRoute = {
  path: string;
  name: string;
  summary: string;
  changeFrequency: "daily" | "weekly" | "monthly";
  priority: number;
};

export const PUBLIC_ROUTES: PublicRoute[] = [
  {
    path: "/",
    name: "Home",
    summary: "What Jongo is: domain search, managed hosting for WordPress, Next.js, Nuxt and Node, and free migration.",
    changeFrequency: "weekly",
    priority: 1
  },
  {
    path: "/pricing",
    name: "Pricing",
    summary: "The four plans (Starter Cloud, Pro Cloud, Core SLA, Enterprise SLA), monthly and annual prices, allocations, support SLAs and overage rates.",
    changeFrequency: "weekly",
    priority: 0.9
  },
  {
    path: "/domains",
    name: "Register a domain",
    summary: "Domain search and registration, prices per ending, free WHOIS privacy.",
    changeFrequency: "weekly",
    priority: 0.8
  },
  {
    path: "/domains/transfer",
    name: "Transfer a domain",
    summary: "How to move a domain to Jongo, transfer prices, and what happens to the site during a transfer.",
    changeFrequency: "monthly",
    priority: 0.7
  },
  {
    path: "/contact",
    name: "Contact",
    summary: "Talk to the team about migrating a site, agency pricing or a broken site that needs fixing.",
    changeFrequency: "monthly",
    priority: 0.6
  }
];

/**
 * Per-page metadata: title, description, canonical URL, Open Graph and
 * Twitter. The site-wide image comes from app/opengraph-image.tsx.
 */
/** The generated share image (app/opengraph-image.tsx). Set on every page: a page's own openGraph replaces the inherited one. */
export const SHARE_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: `${SITE_NAME}: managed hosting and domains` };

export function pageMetadata(input: { path: string; title: string; description: string; absoluteTitle?: boolean }): Metadata {
  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: { canonical: input.path },
    openGraph: {
      type: "website",
      url: input.path,
      siteName: SITE_NAME,
      title: input.absoluteTitle ? input.title : `${input.title} | ${SITE_NAME}`,
      description: input.description,
      locale: "en_US",
      images: [SHARE_IMAGE]
    },
    twitter: {
      card: "summary_large_image",
      title: input.absoluteTitle ? input.title : `${input.title} | ${SITE_NAME}`,
      description: input.description,
      images: [SHARE_IMAGE.url]
    }
  };
}

/** Metadata for pages that must never be indexed (the app, sign-in, internal tools). */
export const NOINDEX: Metadata = {
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } }
};

// ---------------------------------------------------------------------------
// Structured data (schema.org JSON-LD)
// ---------------------------------------------------------------------------

type JsonLd = Record<string, unknown>;

const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;

export function organizationJsonLd(): JsonLd {
  const email = contactEmail();
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE_NAME,
    url: SITE_URL,
    logo: absoluteUrl("/assets/images/jongo-logo-color.png"),
    description: SITE_DESCRIPTION,
    ...(email ? { email, contactPoint: { "@type": "ContactPoint", contactType: "customer support", email, availableLanguage: ["English"] } } : {})
  };
}

export function websiteJsonLd(): JsonLd {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    url: SITE_URL,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    publisher: { "@id": ORG_ID },
    inLanguage: "en-US"
  };
}

function money(amount: number): string {
  return amount.toFixed(2);
}

/** One plan as a Product with a monthly and an annual Offer. */
export function planJsonLd(plan: TierPlan): JsonLd {
  const offer = (amount: number, unit: "MON" | "ANN", label: string) => ({
    "@type": "Offer",
    name: `${plan.name} (${label})`,
    price: money(amount),
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: absoluteUrl("/pricing"),
    seller: { "@id": ORG_ID },
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: money(amount),
      priceCurrency: "USD",
      referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: unit }
    }
  });
  return {
    "@type": "Product",
    "@id": `${SITE_URL}/pricing#${plan.id}`,
    name: `${SITE_NAME} ${plan.name}`,
    description: `${plan.blurb} ${plan.compute.ram}, ${plan.compute.vcpu}, ${plan.compute.bandwidth}, ${plan.compute.storage}. ${plan.supportSla}.`,
    category: plan.category === "sla" ? "Managed web hosting with SLA" : "Managed web hosting",
    brand: { "@type": "Brand", name: SITE_NAME },
    offers: [offer(plan.monthlyPrice, "MON", "monthly"), offer(plan.annualPrice, "ANN", "annual")],
    additionalProperty: [
      { "@type": "PropertyValue", name: "RAM", value: plan.compute.ram },
      { "@type": "PropertyValue", name: "vCPU", value: plan.compute.vcpu },
      { "@type": "PropertyValue", name: "Bandwidth", value: plan.compute.bandwidth },
      { "@type": "PropertyValue", name: "Storage", value: plan.compute.storage },
      { "@type": "PropertyValue", name: "Included developer time", value: plan.devHours ?? "None" },
      { "@type": "PropertyValue", name: "Support", value: plan.supportSla },
      { "@type": "PropertyValue", name: "Bandwidth overage", value: plan.overageRates.bandwidth },
      { "@type": "PropertyValue", name: "Storage overage", value: plan.overageRates.storage },
      { "@type": "PropertyValue", name: "Ad-hoc developer rate", value: plan.overageRates.adHocDev }
    ]
  };
}

export function plansJsonLd(): JsonLd {
  return {
    "@type": "ItemList",
    "@id": `${SITE_URL}/pricing#plans`,
    name: `${SITE_NAME} hosting plans`,
    itemListElement: ALL_PLANS.map((plan, index) => ({ "@type": "ListItem", position: index + 1, item: planJsonLd(plan) }))
  };
}

export function faqJsonLd(items: Array<{ q: string; a: string }>, path: string): JsonLd {
  return {
    "@type": "FAQPage",
    "@id": `${absoluteUrl(path)}#faq`,
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a }
    }))
  };
}

export function breadcrumbJsonLd(trail: Array<{ name: string; path: string }>): JsonLd {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "Home", path: "/" }, ...trail].map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path)
    }))
  };
}

export function serviceJsonLd(input: { path: string; name: string; description: string; serviceType: string }): JsonLd {
  return {
    "@type": "Service",
    "@id": `${absoluteUrl(input.path)}#service`,
    name: input.name,
    description: input.description,
    serviceType: input.serviceType,
    provider: { "@id": ORG_ID },
    areaServed: "Worldwide",
    url: absoluteUrl(input.path)
  };
}

/** Wraps nodes in one @graph so they can reference each other by @id. */
export function jsonLdGraph(...nodes: JsonLd[]): JsonLd {
  return { "@context": "https://schema.org", "@graph": nodes };
}
