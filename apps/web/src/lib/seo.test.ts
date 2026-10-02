import { describe, expect, it } from "vitest";
import { ALL_PLANS, PRICING_FAQ } from "./public-plans";
import { buildLlmsFullTxt, buildLlmsTxt } from "./llms-txt";
import { PUBLIC_ROUTES, SITE_URL, absoluteUrl, faqJsonLd, pageMetadata, planJsonLd } from "./seo";
import robots from "../app/robots";
import sitemap from "../app/sitemap";

describe("llms.txt", () => {
  const txt = buildLlmsTxt();

  it("follows the llmstxt.org shape: H1, blockquote summary, H2 sections, an Optional section", () => {
    const lines = txt.split("\n");
    expect(lines[0]).toBe("# Jongo");
    expect(lines[2].startsWith("> ")).toBe(true);
    expect(txt).toMatch(/\n## Plans\n/);
    expect(txt).toMatch(/\n## Pages\n/);
    expect(txt).toMatch(/\n## Optional\n/);
  });

  it("states every plan's real prices, from the same data the pricing page renders", () => {
    for (const plan of ALL_PLANS) {
      expect(txt).toContain(`**${plan.name}** — $${plan.monthlyPrice.toLocaleString("en-US")}/month or $${plan.annualPrice.toLocaleString("en-US")}/year`);
      expect(txt).toContain(plan.devHours);
    }
  });

  it("links every public page with an absolute URL", () => {
    for (const route of PUBLIC_ROUTES) expect(txt).toContain(`](${absoluteUrl(route.path)})`);
  });

  it("puts every plan feature and FAQ in the full version", () => {
    const full = buildLlmsFullTxt();
    for (const plan of ALL_PLANS) for (const feature of plan.features) expect(full).toContain(feature);
    for (const item of PRICING_FAQ) expect(full).toContain(item.q);
    expect(full).toContain("| Metric | Starter Cloud | Pro Cloud | Core SLA | Enterprise SLA |");
  });
});

describe("robots.txt and sitemap", () => {
  it("keeps the app and API out of every crawler group, AI crawlers included", () => {
    const rules = robots().rules as Array<{ userAgent: string | string[]; disallow?: string | string[] }>;
    expect(rules.length).toBe(2);
    for (const rule of rules) {
      for (const path of ["/api/", "/auth/", "/dashboard", "/my-domains"]) expect(rule.disallow).toContain(path);
    }
    expect(rules[1].userAgent).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot", "PerplexityBot", "OAI-SearchBot"]));
  });

  it("points at the canonical sitemap and lists exactly the public pages", () => {
    expect(robots().sitemap).toBe(`${SITE_URL}/sitemap.xml`);
    expect(sitemap().map((entry) => entry.url)).toEqual(PUBLIC_ROUTES.map((route) => absoluteUrl(route.path)));
  });
});

describe("structured data and page metadata", () => {
  it("gives each plan a monthly and an annual USD offer", () => {
    const product = planJsonLd(ALL_PLANS[0]) as { offers: Array<{ price: string; priceCurrency: string }> };
    expect(product.offers.map((offer) => offer.price)).toEqual([ALL_PLANS[0].monthlyPrice.toFixed(2), ALL_PLANS[0].annualPrice.toFixed(2)]);
    expect(product.offers.every((offer) => offer.priceCurrency === "USD")).toBe(true);
  });

  it("builds an FAQPage from the same questions the page shows", () => {
    const faq = faqJsonLd(PRICING_FAQ, "/pricing") as { mainEntity: Array<{ name: string }> };
    expect(faq.mainEntity.map((q) => q.name)).toEqual(PRICING_FAQ.map((item) => item.q));
  });

  it("sets a canonical URL and share tags per page", () => {
    const meta = pageMetadata({ path: "/pricing", title: "Pricing", description: "d" });
    expect(meta.alternates?.canonical).toBe("/pricing");
    expect(meta.openGraph).toMatchObject({ url: "/pricing", title: "Pricing | Jongo" });
  });
});
