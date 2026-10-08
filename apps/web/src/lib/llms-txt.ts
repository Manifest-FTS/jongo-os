/**
 * llms.txt and llms-full.txt (https://llmstxt.org): a plain-markdown summary
 * of the site for AI assistants, so a question like "how much is Jongo's Pro
 * plan?" is answered from the real figures rather than a guess.
 *
 * Built from lib/public-plans.ts, the data the pricing page renders, so the
 * two cannot drift apart. Pure: tested in llms-txt.test.ts.
 */

import { ALL_PLANS, PRICING_FAQ, PRICING_MATRIX_ROWS, type TierPlan } from "@/lib/public-plans";
import { PUBLIC_ROUTES, SITE_DESCRIPTION, SITE_NAME, absoluteUrl } from "@/lib/seo";

function dollars(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

function planLine(plan: TierPlan): string {
  return (
    `- **${plan.name}** — ${dollars(plan.monthlyPrice)}/month or ${dollars(plan.annualPrice)}/year. ` +
    `${plan.compute.ram}, ${plan.compute.vcpu}, ${plan.compute.bandwidth}, ${plan.compute.storage}. ` +
    `Support: ${plan.supportSla}. ` +
    (plan.devHours ? `Included developer time: ${plan.devHours}. ` : "") +
    `Overages: ${plan.overageRates.bandwidth} bandwidth, ${plan.overageRates.storage} storage, ${plan.overageRates.adHocDev} extra developer time.`
  );
}

const ABOUT = [
  "Jongo hosts the sites and apps agencies and small businesses look after: WordPress, Next.js, Nuxt, Node and static sites, with managed Postgres, MySQL and Redis behind them.",
  "Every plan includes unlimited projects and staging environments, Git push-to-deploy, wildcard SSL, nightly offsite backups with one-click restore, a web application firewall with DDoS protection, and unlimited collaborators with no per-seat fees.",
  "Domains can be registered or transferred in Jongo, with free WHOIS privacy and DNS managed for you. Transfers include a year's renewal.",
  "Moving an existing site in is free, and if the site is broken when it arrives (white screen, failed update, plugin conflict) the fix is part of the move.",
  "Annual billing costs ten months' worth: two months free. There are no contracts and no minimum term."
];

export function buildLlmsTxt(): string {
  const lines: string[] = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    ...ABOUT.map((sentence) => `- ${sentence}`),
    "",
    "## Plans",
    "",
    ...ALL_PLANS.map(planLine),
    "",
    "Starter Cloud and Pro Cloud are hosting plans with best-effort uptime. Core SLA and Enterprise SLA add a formal uptime guarantee with service credits, faster response times and included developer hours.",
    "",
    "## Pages",
    "",
    ...PUBLIC_ROUTES.map((route) => `- [${route.name}](${absoluteUrl(route.path)}): ${route.summary}`),
    "",
    "## Optional",
    "",
    `- [Full details](${absoluteUrl("/llms-full.txt")}): every plan feature, the full usage and escalation matrix, and the pricing FAQ in one file.`
  ];
  return `${lines.join("\n")}\n`;
}

export function buildLlmsFullTxt(): string {
  const lines: string[] = [`# ${SITE_NAME}: full details`, "", `> ${SITE_DESCRIPTION}`, "", "## About", "", ...ABOUT.map((s) => `- ${s}`), ""];

  lines.push("## Plans in detail", "");
  for (const plan of ALL_PLANS) {
    lines.push(`### ${plan.name} (${plan.categoryLabel})`, "");
    lines.push(`- Price: ${dollars(plan.monthlyPrice)} per month, or ${dollars(plan.annualPrice)} per year billed annually.`);
    lines.push(`- Best for: ${plan.targetAudience}.`);
    lines.push(`- ${plan.blurb}`);
    lines.push(`- Compute: ${plan.compute.ram}, ${plan.compute.vcpu}, ${plan.compute.bandwidth}, ${plan.compute.storage}.`);
    lines.push(`- Support: ${plan.supportSla}.`);
    if (plan.uptimeGuarantee) lines.push(`- Uptime: ${plan.uptimeGuarantee}.`);
    else if (plan.uptimeNote) lines.push(`- Uptime: ${plan.uptimeNote}.`);
    if (plan.devHours) lines.push(`- Included developer time: ${plan.devHours}.`);
    lines.push(
      `- Overage rates: bandwidth ${plan.overageRates.bandwidth}, storage ${plan.overageRates.storage}, ad-hoc developer time ${plan.overageRates.adHocDev}.`
    );
    lines.push("- Includes:");
    for (const feature of plan.features) lines.push(`  - ${feature}`);
    lines.push("");
  }

  lines.push("## Usage and escalation matrix", "");
  lines.push("| Metric | Starter Cloud | Pro Cloud | Core SLA | Enterprise SLA |", "|---|---|---|---|---|");
  for (const row of PRICING_MATRIX_ROWS) {
    lines.push(`| ${row.metric} | ${row.starter} | ${row.pro} | ${row.coreSla} | ${row.enterpriseSla} |`);
  }
  lines.push("");

  lines.push("## Frequently asked questions", "");
  for (const item of PRICING_FAQ) lines.push(`### ${item.q}`, "", item.a, "");

  lines.push("## Pages", "");
  for (const route of PUBLIC_ROUTES) lines.push(`- [${route.name}](${absoluteUrl(route.path)}): ${route.summary}`);

  return `${lines.join("\n")}\n`;
}
