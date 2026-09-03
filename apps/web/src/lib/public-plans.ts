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

export type Plan = {
  id: "seed" | "growth" | "summit";
  name: string;
  icon: string;
  blurb: string;
  /** Placeholder. Monthly, in the currency named by CURRENCY_LABEL. */
  price: string;
  /** Headline list shown on a plan card. */
  features: string[];
  featured?: boolean;
};

export const PLANS: Plan[] = [
  {
    id: "seed",
    name: "Seed",
    icon: "/assets/images/icon-plan-seed.png",
    blurb: "One site or app that needs to stay up and stay backed up.",
    price: "$1500",
    features: [
      "1 site or app, any stack",
      "Nightly offsite backups, 30-day history",
      "Free SSL and CDN",
      "Privacy mode and SFTP",
      "Email support"
    ]
  },
  {
    id: "growth",
    name: "Growth",
    icon: "/assets/images/icon-plan-growth.png",
    blurb: "A handful of client projects, with staging you can hand over.",
    price: "$4900",
    featured: true,
    features: [
      "Up to 5 sites or apps, any stack",
      "Everything in Seed, 90-day history",
      "Staging, promote and Git deploys",
      "Client logins with scoped roles",
      "Malware and plugin monitoring"
    ]
  },
  {
    id: "summit",
    name: "Summit",
    icon: "/assets/images/icon-plan-summit.png",
    blurb: "A portfolio of sites and apps, with the reporting to prove they are cared for.",
    price: "$11900",
    features: [
      "Up to 20 sites or apps, any stack",
      "Everything in Growth, 1-year history",
      "Monthly backup restore rehearsals",
      `Priority support, ${RESPONSE_TIME} response`,
      "Named account contact"
    ]
  }
];

/**
 * The comparison table.
 *
 * A cell is either a limit/label or a yes/no. Written as data so a row cannot
 * say one thing here and another on a plan card — and so adding a plan is one
 * edit, not three columns of markup.
 */
export type ComparisonValue = string | boolean;

export type ComparisonRow = {
  label: string;
  /** Marked when the capability only exists on WordPress. */
  wordpressOnly?: boolean;
  seed: ComparisonValue;
  growth: ComparisonValue;
  summit: ComparisonValue;
};

export type ComparisonGroup = { group: string; rows: ComparisonRow[] };

export const COMPARISON: ComparisonGroup[] = [
  {
    group: "What you can host",
    rows: [
      { label: "Sites or apps included", seed: "1", growth: "5", summit: "20" },
      { label: "WordPress, Next.js, Nuxt, Node, static", seed: true, growth: true, summit: true },
      { label: "Managed Postgres, MySQL or Redis", seed: true, growth: true, summit: true },
      { label: "Deploy from a Git branch", seed: true, growth: true, summit: true },
      { label: "Dockerfile or compose builds", seed: false, growth: true, summit: true }
    ]
  },
  {
    group: "Backups",
    rows: [
      { label: "Nightly offsite backups", seed: true, growth: true, summit: true },
      { label: "Snapshot history", seed: "30 days", growth: "90 days", summit: "1 year" },
      { label: "One-click restore, with a safety snapshot first", seed: true, growth: true, summit: true },
      { label: "Download a backup", seed: true, growth: true, summit: true },
      { label: "Monthly restore rehearsals", seed: false, growth: false, summit: true }
    ]
  },
  {
    group: "Working on sites",
    rows: [
      { label: "Staging copy", seed: false, growth: true, summit: true },
      { label: "Promote staging to production", seed: false, growth: true, summit: true },
      { label: "Per-site SFTP credentials", seed: true, growth: true, summit: true },
      { label: "Cache flush, including Cloudflare edge", seed: true, growth: true, summit: true },
      { label: "Elementor CSS flush", wordpressOnly: true, seed: true, growth: true, summit: true },
      { label: "Privacy mode before launch", wordpressOnly: true, seed: true, growth: true, summit: true }
    ]
  },
  {
    group: "People and oversight",
    rows: [
      { label: "Client logins with scoped roles", seed: false, growth: true, summit: true },
      { label: "Plugin inventory", wordpressOnly: true, seed: false, growth: true, summit: true },
      { label: "Scheduled malware scans", wordpressOnly: true, seed: false, growth: true, summit: true },
      { label: "Named account contact", seed: false, growth: false, summit: true }
    ]
  }
];

export const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "Can I change plan later?",
    a: "Yes, up or down, at any time. Moving up takes effect immediately and is charged pro rata; moving down applies at your next renewal so you do not lose a month you have paid for."
  },
  {
    q: "What counts as one site?",
    a: "One production site or app, plus its staging copy and the database behind it. A staging environment is never billed as a second site."
  },
  {
    q: "Do you charge for the migration?",
    a: "No. We move your existing sites across, including the database and the DNS cutover, as part of getting you set up."
  },
  {
    q: "What happens if I go over my site limit?",
    a: "Nothing breaks and nothing is deleted. We get in touch about moving you to the next plan up."
  },
  {
    q: "Is there a contract?",
    a: "No minimum term. Cancel whenever you like and we will help you move the sites somewhere else — your backups are yours to download at any point."
  }
];
