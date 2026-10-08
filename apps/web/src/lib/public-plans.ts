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
  /** Omitted for tiers with no included dev time. */
  devHours?: string;
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
    categoryLabel: "Hosting",
    monthlyPrice: 45,
    annualPrice: 450,
    blurb: "For small business sites, a single WordPress site, or a landing page.",
    targetAudience: "Small businesses, single WordPress sites, portfolio sites",
    compute: {
      ram: "2 GB RAM",
      vcpu: "1 vCPU (shared)",
      bandwidth: "250 GB bandwidth",
      storage: "25 GB storage"
    },
    supportSla: "Standard Ticketing (48-hr response)",
    uptimeNote: "99.5% target (no guarantee)",
    features: [
      "Unlimited sites and staging copies",
      "Unlimited team members, no per-seat fees",
      "Nightly backups, stored offsite",
      "Free SSL certificates",
      "Deploy straight from Git",
      "Firewall and DDoS protection",
      "Email support, replies within 48 hours"
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
    categoryLabel: "Hosting",
    monthlyPrice: 75,
    annualPrice: 750,
    blurb: "For web apps, online stores, and busier WordPress sites that need more power.",
    targetAudience: "Web apps, Next.js/React sites, busy WordPress sites",
    featured: true,
    badge: "Most popular",
    compute: {
      ram: "4 GB RAM",
      vcpu: "2 vCPUs (dedicated)",
      bandwidth: "500 GB bandwidth",
      storage: "50 GB storage"
    },
    devHours: "1 Dev Hour / Quarter ($120 value)",
    supportSla: "Standard Ticketing (48-hr response)",
    uptimeNote: "99.5% target (no guarantee)",
    features: [
      "Everything in Starter Cloud",
      "Twice the memory, CPU, bandwidth and storage",
      "Automatic database backups",
      "Custom Docker setups",
      "Encrypted environment variables",
      "1 developer hour per quarter ($120 value)"
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
    categoryLabel: "Managed",
    monthlyPrice: 149,
    annualPrice: 1490,
    blurb: "For agencies, nonprofits, and businesses with several sites that want us looking after them.",
    targetAudience: "Agencies, multi-site nonprofits, client portfolios",
    featured: true,
    badge: "Best for agencies",
    compute: {
      ram: "8 GB RAM",
      vcpu: "4 vCPUs",
      bandwidth: "1 TB bandwidth",
      storage: "100 GB storage"
    },
    devHours: "3 Dev Hours / Quarter ($360 value)",
    supportSla: "12-Hour Response Time (Mon–Sat, excluding Sundays)",
    uptimeGuarantee: "99.9% uptime guarantee",
    features: [
      "Everything in Pro Cloud",
      "99.9% uptime guarantee, with credits if we miss it",
      "Replies within 12 hours (Mon–Sat)",
      "3 developer hours per quarter ($360 value)",
      "Each site kept separate, so one can't affect another",
      "We move sites from cPanel or your old host, redirects included",
      "We look after your domains and DNS",
      "Security check-up every quarter",
      "Domain and SSL costs itemized on your bill"
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
    categoryLabel: "Managed",
    monthlyPrice: 349,
    annualPrice: 3490,
    blurb: "For high-traffic stores, SaaS products, and sites where downtime costs real money.",
    targetAudience: "High-traffic stores, SaaS products, business-critical sites",
    badge: "Most capacity",
    compute: {
      ram: "16 GB RAM",
      vcpu: "8 vCPUs (isolated)",
      bandwidth: "2 TB bandwidth",
      storage: "250 GB storage"
    },
    devHours: "5 Dev Hours / Quarter ($600 value)",
    supportSla: "12-Hour Response Time (Mon–Sat, excluding Sundays)",
    uptimeGuarantee: "99.99% uptime guarantee",
    features: [
      "Everything in Core SLA",
      "99.99% uptime guarantee, with credits if we miss it",
      "Replies within 12 hours (Mon–Sat)",
      "5 developer hours per quarter ($600 value)",
      "Private Slack channel plus direct phone and text",
      "Backup server in a second region if the main one fails",
      "Custom firewall rules and rate limits",
      "Database tuning for heavy traffic",
      "Automatic checks that staging matches live before you publish"
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
  category: "Resources" | "Support" | "Extra usage" | "Included";
  starter: string;
  pro: string;
  coreSla: string;
  enterpriseSla: string;
  highlight?: boolean;
};

export const PRICING_MATRIX_ROWS: MatrixRow[] = [
  {
    metric: "Price",
    category: "Resources",
    starter: "$45 / mo ($450 / yr)",
    pro: "$75 / mo ($750 / yr)",
    coreSla: "$149 / mo ($1,490 / yr)",
    enterpriseSla: "$349 / mo ($3,490 / yr)",
    highlight: true
  },
  {
    metric: "Memory / CPU",
    category: "Resources",
    starter: "2 GB / 1 vCPU (shared)",
    pro: "4 GB / 2 vCPU (dedicated)",
    coreSla: "8 GB / 4 vCPU",
    enterpriseSla: "16 GB / 8 vCPU (isolated)",
    highlight: true
  },
  {
    metric: "Bandwidth",
    category: "Resources",
    starter: "250 GB / mo",
    pro: "500 GB / mo",
    coreSla: "1 TB / mo",
    enterpriseSla: "2 TB / mo"
  },
  {
    metric: "Storage",
    category: "Resources",
    starter: "25 GB",
    pro: "50 GB",
    coreSla: "100 GB",
    enterpriseSla: "250 GB"
  },
  {
    metric: "Team members & sites",
    category: "Included",
    starter: "Unlimited",
    pro: "Unlimited",
    coreSla: "Unlimited",
    enterpriseSla: "Unlimited"
  },
  {
    metric: "Staging copies",
    category: "Included",
    starter: "Included",
    pro: "Included",
    coreSla: "Included, with custom sync",
    enterpriseSla: "Included, with automatic checks"
  },
  {
    metric: "Developer time",
    category: "Support",
    starter: "None",
    pro: "1 Dev Hr / Quarter ($120 value)",
    coreSla: "3 Dev Hrs / Quarter ($360 value)",
    enterpriseSla: "5 Dev Hrs / Quarter ($600 value)",
    highlight: true
  },
  {
    metric: "Support response",
    category: "Support",
    starter: "48-Hour Email",
    pro: "48-Hour Email",
    coreSla: "12-Hour Response Time (Mon–Sat, excl. Sundays)",
    enterpriseSla: "12-Hour Response Time (Mon–Sat, excl. Sundays)",
    highlight: true
  },
  {
    metric: "Uptime",
    category: "Support",
    starter: "99.5% target",
    pro: "99.5% target",
    coreSla: "99.9% guaranteed, with credits",
    enterpriseSla: "99.99% guaranteed, with credits"
  },
  {
    metric: "How to reach us",
    category: "Support",
    starter: "Email",
    pro: "Email",
    coreSla: "Priority email",
    enterpriseSla: "Private Slack + phone/text"
  },
  {
    metric: "Extra bandwidth",
    category: "Extra usage",
    starter: "$0.05 / GB",
    pro: "$0.05 / GB",
    coreSla: "$0.05 / GB",
    enterpriseSla: "$0.03 / GB"
  },
  {
    metric: "Extra storage",
    category: "Extra usage",
    starter: "$0.20 / GB",
    pro: "$0.20 / GB",
    coreSla: "$0.20 / GB",
    enterpriseSla: "$0.15 / GB"
  },
  {
    metric: "Extra developer time",
    category: "Extra usage",
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
    group: "Resources",
    rows: [
      { label: "Memory", starter: "2 GB", pro: "4 GB", coreSla: "8 GB", enterpriseSla: "16 GB" },
      { label: "CPU", starter: "1 vCPU (shared)", pro: "2 vCPU (dedicated)", coreSla: "4 vCPUs", enterpriseSla: "8 vCPUs (isolated)" },
      { label: "Bandwidth", starter: "250 GB / mo", pro: "500 GB / mo", coreSla: "1 TB / mo", enterpriseSla: "2 TB / mo" },
      { label: "Storage", starter: "25 GB", pro: "50 GB", coreSla: "100 GB", enterpriseSla: "250 GB" },
      { label: "WordPress, Next.js, Node and static sites", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Managed databases (Postgres, MySQL, Redis)", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Deploy straight from Git", starter: true, pro: true, coreSla: true, enterpriseSla: true }
    ]
  },
  {
    group: "Backups",
    rows: [
      { label: "Nightly offsite backups", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Backup history", starter: "30 days", pro: "90 days", coreSla: "180 days", enterpriseSla: "1 year" },
      { label: "One-click restore", starter: true, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Automatic database backups", starter: false, pro: true, coreSla: true, enterpriseSla: true },
      { label: "Regular test restores", starter: false, pro: false, coreSla: true, enterpriseSla: true }
    ]
  },
  {
    group: "Support",
    rows: [
      { label: "Developer time", starter: false, pro: "1 hr / quarter ($120 value)", coreSla: "3 hrs / quarter ($360 value)", enterpriseSla: "5 hrs / quarter ($600 value)" },
      { label: "Support response", starter: "48-hour email", pro: "48-hour email", coreSla: "12 hours (Mon–Sat)", enterpriseSla: "12 hours (Mon–Sat)" },
      { label: "Uptime", starter: "99.5% target", pro: "99.5% target", coreSla: "99.9% guaranteed", enterpriseSla: "99.99% guaranteed" },
      { label: "Private Slack channel", starter: false, pro: false, coreSla: false, enterpriseSla: true },
      { label: "Direct phone / text line", starter: false, pro: false, coreSla: false, enterpriseSla: true }
    ]
  }
];

export const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "Do you charge per user or per seat?",
    a: "No. Every plan includes unlimited team members, so you can invite your developers, contractors and clients without your bill going up. You pay for the plan, not the people."
  },
  {
    q: "How many sites can I host on one plan?",
    a: "As many as fit in your plan's memory and storage. Every site gets its own staging copy at no extra cost. If you outgrow your plan, you can upgrade at any time."
  },
  {
    q: "Will you move my existing site over?",
    a: "Yes, and moving in is free. If your site arrives broken, say a white screen, a failed update or a plugin conflict, we fix it as part of the move."
  },
  {
    q: "Can I use my own domain?",
    a: "Yes. Connect a domain you already own at any time, or register or transfer one with us. Domains come with free WHOIS privacy and we manage the DNS for you. Transfers include a year's renewal, and SSL certificates are free on every plan."
  },
  {
    q: "How do backups work?",
    a: "Every site is backed up nightly and stored offsite with a separate provider, so your backups are safe even if a server fails. You can restore with one click. We keep 30 days of backups on Starter, 90 on Pro, 180 on Core SLA and a full year on Enterprise SLA."
  },
  {
    q: "What's the difference between Hosting and Managed plans?",
    a: "With Hosting plans (Starter and Pro) we keep the servers running and you manage your sites, with email support that replies within 48 hours. With Managed plans (Core SLA and Enterprise SLA) we also look after the sites for you: a written uptime guarantee with credits if we miss it, replies within 12 hours Monday to Saturday, and more developer hours each quarter."
  },
  {
    q: "What can I use my developer hours for?",
    a: "Small jobs like content changes, plugin and theme updates, DNS changes, bug fixes and speed tweaks. Pro includes 1 hour a quarter, Core SLA 3 hours and Enterprise SLA 5 hours. Hours reset each quarter and don't roll over. If you need more, extra time is billed at your plan's hourly rate."
  },
  {
    q: "What if I go over my bandwidth or storage?",
    a: "There are no surprise fees. We'll let you know in your dashboard when you reach 80% of your allowance, and anything over is billed at your plan's per-GB rate, which is listed in the comparison table above."
  },
  {
    q: "Is there a contract? Can I cancel or switch plans?",
    a: "There's no contract and no minimum term. Pay monthly, or pay yearly and get two months free. You can upgrade, downgrade or cancel at any time from your account."
  }
];
