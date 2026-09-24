/**
 * The plans, in one place.
 *
 * Both /hosting and /pricing render these. They were briefly going to be two
 * separate lists, which is how a price ends up correct on one page and stale on
 * the other — the same duplication that let the cache-flush script and its
 * library disagree about what a flush covers.
 *
 * PRICES ARE PLACEHOLDERS. Replace `price` with the real figures before this is
 * public; the currency label lives in lib/public-site.ts.
 */

import { RESPONSE_TIME } from "@/lib/public-site";

export type PlanCategory = "hosting" | "sla";

export type TierPlan = {
  id: "starter" | "pro" | "core-sla" | "enterprise-sla";
  name: string;
  category: PlanCategory;
  categoryLabel: string;
  monthlyPrice: number;
  annualPrice: number;
  blurb: string;
  targetAudience: string;
  compute: {
    ram: string;
    vcpu: string;
    bandwidth: string;
    storage: string;
  };
  devHours: string;
  supportSla: string;
  uptimeGuarantee?: string;
  /** Plain-text uptime expectation for tiers that don't carry a credited SLA badge. */
  uptimeNote?: string;
  features: string[];
  featured?: boolean;
  badge?: string;
  overageRates: {
    bandwidth: string;
    storage: string;
    adHocDev: string;
  };
};

export const HOSTING_TIERS: TierPlan[] = [
  {
    id: "starter",
    name: "Starter Cloud",
    category: "hosting",
    categoryLabel: "Hosting Tier I",
    monthlyPrice: 45,
    annualPrice: 450,
    blurb: "Ideal for static sites, single WordPress instances, and small business landing pages.",
    targetAudience: "Small businesses, single WordPress instances, portfolio sites",
    compute: {
      ram: "2 GB RAM",
      vcpu: "1 vCPU (Shared)",
      bandwidth: "250 GB Egress Bandwidth",
      storage: "25 GB SSD Storage"
    },
    devHours: "0 Hours Included",
    supportSla: "Standard Ticketing (48-hr response)",
    uptimeNote: "~99.5% expected uptime (best-effort, no SLA credits)",
    features: [
      "2 GB RAM / 1 vCPU (Shared)",
      "250 GB Egress / 25 GB SSD Storage",
      "Unlimited projects & staging environments",
      "Git push-to-deploy pipelines",
      "Wildcard SSL & Automated TLS",
      "Daily automated backups (24h RPO)",
      "Global WAF & DDoS protection",
      "Zero seat fees (unlimited collaborators)",
      "48-hour email support response"
    ],
    overageRates: {
      bandwidth: "$0.05 / GB",
      storage: "$0.20 / GB",
      adHocDev: "$120 / hr"
    }
  },
  {
    id: "pro",
    name: "Pro Cloud",
    category: "hosting",
    categoryLabel: "Hosting Tier II",
    monthlyPrice: 75,
    annualPrice: 750,
    blurb: "Ideal for full-stack web applications, SSR frameworks (Next.js/React), and custom CMS setups.",
    targetAudience: "Full-stack apps, SSR Next.js/React, production WordPress",
    featured: true,
    badge: "Popular for Apps",
    compute: {
      ram: "4 GB RAM",
      vcpu: "2 vCPUs (Dedicated allocation)",
      bandwidth: "500 GB Egress Bandwidth",
      storage: "50 GB SSD Storage"
    },
    devHours: "1 Dev Hour / Month",
    supportSla: "Priority SLA (24-hr response)",
    uptimeNote: "~99.9% expected uptime (best-effort, no SLA credits)",
    features: [
      "4 GB RAM / 2 vCPUs (Dedicated allocation)",
      "500 GB Egress / 50 GB SSD Storage",
      "Everything in Starter Cloud",
      "Custom Docker & Compose configurations",
      "Automated database snapshotting",
      "Environment variable encryption & protection",
      "1 dev hour per month included (use-it-or-lose-it)",
      "Priority 24-hour response SLA"
    ],
    overageRates: {
      bandwidth: "$0.05 / GB",
      storage: "$0.20 / GB",
      adHocDev: "$100 / hr"
    }
  }
];

export const SLA_TIERS: TierPlan[] = [
  {
    id: "core-sla",
    name: "Core SLA",
    category: "sla",
    categoryLabel: "Managed Agency SLA",
    monthlyPrice: 149,
    annualPrice: 1490,
    blurb: "Ideal for multi-site non-profits, established SMBs, and portfolio clients needing active management.",
    targetAudience: "Multi-site non-profits, agencies, client portfolios",
    featured: true,
    badge: "Agency Standard",
    compute: {
      ram: "8 GB RAM",
      vcpu: "4 vCPUs",
      bandwidth: "1 TB Egress Bandwidth",
      storage: "100 GB SSD Storage"
    },
    devHours: "2 Dev Hours / Month",
    supportSla: "Next-Business-Day SLA (12-hr window)",
    uptimeGuarantee: "99.9% Uptime Guarantee",
    features: [
      "8 GB RAM / 4 vCPUs",
      "1 TB Egress / 100 GB SSD Storage",
      "Everything in Pro Cloud",
      "Multi-site CMS routing & isolation",
      "cPanel / legacy redirect migration management",
      "Domain & DNS portfolio maintenance",
      "Quarterly security & vulnerability audits",
      "2 dev hours per month included",
      "12-hour Next-Business-Day response SLA",
      "99.9% Uptime Guarantee with SLA credits",
      "Itemized domain/SSL pass-through billing support"
    ],
    overageRates: {
      bandwidth: "$0.05 / GB",
      storage: "$0.20 / GB",
      adHocDev: "$90 / hr"
    }
  },
  {
    id: "enterprise-sla",
    name: "Enterprise SLA",
    category: "sla",
    categoryLabel: "Mission-Critical Enterprise",
    monthlyPrice: 349,
    annualPrice: 3490,
    blurb: "Ideal for high-traffic commercial platforms, active SaaS apps, and mission-critical systems requiring rapid emergency escalation.",
    targetAudience: "High-traffic commerce, SaaS, 24/7 mission-critical services",
    badge: "24/7 Emergency",
    compute: {
      ram: "16 GB RAM",
      vcpu: "8 vCPUs (Isolated container environment)",
      bandwidth: "2 TB Egress Bandwidth",
      storage: "250 GB SSD Storage"
    },
    devHours: "4 Dev Hours / Month ($360+ value)",
    supportSla: "4-Hour Emergency SLA (24/7 Response)",
    uptimeGuarantee: "99.99% Uptime SLA",
    features: [
      "16 GB RAM / 8 vCPUs (Isolated containers)",
      "2 TB Egress / 250 GB SSD Storage",
      "Everything in Core SLA",
      "Custom WAF security rulesets & rate gates",
      "High-concurrency database optimization",
      "Multi-region failover configurations",
      "Staging-to-production automated parity testing",
      "4 dev hours per month included",
      "4-Hour Emergency SLA (24/7 critical response)",
      "Dedicated private Slack channel + direct phone/text line",
      "99.99% Uptime SLA backed by service credits"
    ],
    overageRates: {
      bandwidth: "$0.03 / GB",
      storage: "$0.15 / GB",
      adHocDev: "$90 / hr"
    }
  }
];

export const ALL_PLANS: TierPlan[] = [...HOSTING_TIERS, ...SLA_TIERS];

export type MatrixRow = {
  metric: string;
  category: "Allocation" | "Support & SLA" | "Overages & Rates" | "Operations";
  starter: string;
  pro: string;
  coreSla: string;
  enterpriseSla: string;
  highlight?: boolean;
};

export const PRICING_MATRIX_ROWS: MatrixRow[] = [
  {
    metric: "Monthly / Annual Price",
    category: "Allocation",
    starter: "$45 / mo ($450 / yr)",
    pro: "$75 / mo ($750 / yr)",
    coreSla: "$149 / mo ($1,490 / yr)",
    enterpriseSla: "$349 / mo ($3,490 / yr)",
    highlight: true
  },
  {
    metric: "RAM / CPU Allocation",
    category: "Allocation",
    starter: "2 GB / 1 vCPU (Shared)",
    pro: "4 GB / 2 vCPU (Dedicated)",
    coreSla: "8 GB / 4 vCPU",
    enterpriseSla: "16 GB / 8 vCPU (Isolated)",
    highlight: true
  },
  {
    metric: "Included Bandwidth",
    category: "Allocation",
    starter: "250 GB / mo",
    pro: "500 GB / mo",
    coreSla: "1 TB / mo",
    enterpriseSla: "2 TB / mo"
  },
  {
    metric: "SSD Storage",
    category: "Allocation",
    starter: "25 GB",
    pro: "50 GB",
    coreSla: "100 GB",
    enterpriseSla: "250 GB"
  },
  {
    metric: "Deployments / Seats",
    category: "Operations",
    starter: "Unlimited",
    pro: "Unlimited",
    coreSla: "Unlimited",
    enterpriseSla: "Unlimited"
  },
  {
    metric: "Staging Environments",
    category: "Operations",
    starter: "Included (.mfts.link)",
    pro: "Included (.mfts.link)",
    coreSla: "Included + Custom Sync",
    enterpriseSla: "Included + Automated Parity"
  },
  {
    metric: "Included Dev Time",
    category: "Support & SLA",
    starter: "0 Hours",
    pro: "1 Hour / Mo",
    coreSla: "2 Hours / Mo",
    enterpriseSla: "4 Hours / Mo",
    highlight: true
  },
  {
    metric: "Support SLA",
    category: "Support & SLA",
    starter: "48-Hour Email",
    pro: "24-Hour Priority",
    coreSla: "12-Hour Next-Day",
    enterpriseSla: "4-Hour Emergency (24/7)",
    highlight: true
  },
  {
    metric: "Uptime Commitment",
    category: "Support & SLA",
    starter: "99.5% Best-Effort",
    pro: "99.9% Best-Effort",
    coreSla: "99.9% Guaranteed",
    enterpriseSla: "99.99% Guaranteed + Credits"
  },
  {
    metric: "Direct Escalation Channel",
    category: "Support & SLA",
    starter: "Ticket / Email",
    pro: "Priority Ticket",
    coreSla: "Priority Ticket + Email",
    enterpriseSla: "Dedicated Slack + Direct Phone/Text"
  },
  {
    metric: "Bandwidth Overage",
    category: "Overages & Rates",
    starter: "$0.05 / GB",
    pro: "$0.05 / GB",
    coreSla: "$0.05 / GB",
    enterpriseSla: "$0.03 / GB"
  },
  {
    metric: "Storage Overage",
    category: "Overages & Rates",
    starter: "$0.20 / GB",
    pro: "$0.20 / GB",
    coreSla: "$0.20 / GB",
    enterpriseSla: "$0.15 / GB"
  },
  {
    metric: "Ad-Hoc Dev Rate",
    category: "Overages & Rates",
    starter: "$120 / hr",
    pro: "$100 / hr",
    coreSla: "$90 / hr",
    enterpriseSla: "$90 / hr",
    highlight: true
  }
];

export type Plan = {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  price: string;
  features: string[];
  featured?: boolean;
};

export const PLANS: Plan[] = ALL_PLANS.map((p) => ({
  id: p.id,
  name: p.name,
  icon: p.category === "hosting" ? "/assets/images/icon-plan-seed.png" : "/assets/images/icon-plan-growth.png",
  blurb: p.blurb,
  price: `$${p.monthlyPrice}`,
  features: p.features.slice(0, 5),
  featured: p.featured
}));

export type ComparisonValue = string | boolean;

export type ComparisonRow = {
  label: string;
  starter: ComparisonValue;
  pro: ComparisonValue;
  coreSla: ComparisonValue;
  enterpriseSla: ComparisonValue;
};

export type ComparisonGroup = { group: string; rows: ComparisonRow[] };

export const COMPARISON: ComparisonGroup[] = [
  {
    group: "Compute & Allocation",
    rows: [
      { label: "RAM Allocation", starter: "2 GB", pro: "4 GB", coreSla: "8 GB", enterpriseSla: "16 GB" },
      { label: "vCPU Compute", starter: "1 vCPU (Shared)", pro: "2 vCPU (Dedicated)", coreSla: "4 vCPUs", enterpriseSla: "8 vCPUs (Isolated)" },
      { label: "Egress Bandwidth", starter: "250 GB / mo", pro: "500 GB / mo", coreSla: "1 TB / mo", enterpriseSla: "2 TB / mo" },
      { label: "SSD Storage", starter: "25 GB", pro: "50 GB", coreSla: "100 GB", enterpriseSla: "250 GB" },
      { label: "WordPress, Next.js, Node, Static", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Managed Postgres, MySQL or Redis", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Git push-to-deploy pipelines", starter: true, pro: true, coreSla: true, enterpriseSla: true }
    ]
  },
  {
    group: "Backups & Recovery",
    rows: [
      { label: "Nightly offsite backups (B2 / Restic)", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Snapshot history & recovery", starter: "30 days", pro: "90 days", coreSla: "180 days", enterpriseSla: "1 year" },
      { label: "1-Click restore with safety probe", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Automated database snapshots", starter: false, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Automated restore rehearsals", starter: false, pro: false, coreSla: true, enterpriseSla: true }
    ]
  },
  {
    group: "Developer Time & SLA",
    rows: [
      { label: "Included Dev Hours", starter: "0 Hours", pro: "1 Hour / Mo", coreSla: "2 Hours / Mo", enterpriseSla: "4 Hours / Mo" },
      { label: "Support Response Window", starter: "48-Hour Email", pro: "24-Hour Priority", coreSla: "12-Hour Next-Day", enterpriseSla: "4-Hour Emergency (24/7)" },
      { label: "Uptime Commitment", starter: "99.5%", pro: "99.9%", coreSla: "99.9% Guaranteed", enterpriseSla: "99.99% + Credits" },
      { label: "Dedicated Slack Channel", starter: false, pro: false, coreSla: false, enterpriseSla: true },
      { label: "Direct Phone / Text Line", starter: false, pro: false, coreSla: false, enterpriseSla: true }
    ]
  }
];

export const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "Do I get a real web address, or some random string?",
    a: "Every site gets a clean, easy-to-share address like yourproject.mfts.link right out of the box — no confusing strings of letters and numbers. Staging copies get their own clearly labeled address too, so you always know which version you're looking at. Ready to use your own domain? You can connect it anytime from your dashboard."
  },
  {
    q: "How do the included support hours work?",
    a: "Every plan above Starter includes a set number of hours each month for small requests — things like content updates, plugin or package updates, DNS changes, or performance tuning. Hours refresh monthly and don't roll over, so use them when you need them. Need more time in a given month? You can always add extra hours at your plan's ad-hoc rate."
  },
  {
    q: "What happens if I go over my bandwidth or storage?",
    a: "We track usage in small, transparent increments and never charge a surprise fee. You'll get a heads-up in your dashboard once you hit 80% of your included bandwidth or storage, and any overage after that is billed at your plan's flat per-GB rate."
  },
  {
    q: "What's the real difference between a Hosting plan and an SLA plan?",
    a: "Hosting plans (Starter, Pro) give you reliable infrastructure and platform tooling, with best-effort uptime and standard support response windows. SLA plans (Core, Enterprise) add a formal uptime guarantee backed by service credits, faster guaranteed response times, more included support hours, and a direct line to our team — built for teams that can't afford downtime."
  },
  {
    q: "Am I locked into a contract?",
    a: "No contracts, no per-seat fees, and no minimum term on any plan. Pay monthly for flexibility, or switch to annual billing to save the equivalent of two months. You can change plans or cancel anytime from your account."
  }
];
