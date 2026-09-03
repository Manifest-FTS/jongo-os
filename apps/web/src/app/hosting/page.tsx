import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY_NAME, CURRENCY_LABEL, contactEmail, currentYear } from "@/lib/public-site";
import { PLANS } from "@/lib/public-plans";
import DomainSearch from "@/components/DomainSearch";
import HeroDashboardPreview from "@/components/HeroDashboardPreview";
import { SUGGESTED_TLDS, formatCents } from "@/lib/domain-search";
import { getPricesForTlds, isPorkbunConfigured } from "@/lib/porkbun";
import { btnPrimary, btnSecondary, card, cardHealthy, cx, publicPage } from "@/lib/public-ui";

/**
 * Public hosting signup page.
 *
 * Deliberately a server component with no session lookup: it is the one page
 * that must render for someone who has never signed in, so it is listed in
 * middleware's PUBLIC_PATHS and touches neither auth() nor the database.
 *
 * Styling follows the app's own vocabulary (globals.css tokens, .btn/.card
 * geometry) as inline styles, the same way the dashboard components do, rather
 * than introducing a second system on a page nobody has to maintain alongside
 * the app shell.
 *
 * Plan choice is carried to the existing /auth/register flow as ?plan=, so the
 * account is created by the registration route that already exists rather than
 * a second, parallel signup path.
 */

/**
 * Regenerated hourly rather than per request.
 *
 * Loading TLD prices made this page async, which by default turns a static
 * marketing page into a server render on every visit. The prices change about
 * never, so ISR is the right trade: the homepage stays a cached static document
 * and picks up new prices within the hour.
 *
 * If the price lookup fails during a build, the search box renders without its
 * price row and the next revalidation repairs it — the page never blocks and
 * never invents a figure.
 */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Hosting for WordPress, Next.js and whatever you ship next | Jongo",
  description:
    "Managed hosting for the sites and apps you look after — WordPress, Next.js, Nuxt, Node and the databases behind them. Nightly offsite backups, one-click staging and free migration."
};

const STACKS = ["WordPress", "Next.js", "Nuxt", "Node", "Static", "Postgres · MySQL · Redis"];

type Feature = { title: string; body: string; wordpressOnly?: boolean; icon: React.ReactNode };

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#4a7a35"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mb-3.5"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const FEATURES: Feature[] = [
  {
    title: "Backups you can actually restore",
    body:
      "Nightly and offsite — files and database together, whether that is a WordPress install, a Node app with Postgres, or a static build. Restore any snapshot in one click, and a safety snapshot is taken first so the restore itself is reversible.",
    icon: (
      <>
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
        <path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
        <path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
      </>
    )
  },
  {
    title: "Staging that promotes cleanly",
    body:
      "Spin up a copy of the live site or app, try the upgrade there, then promote it to production when it holds up. Your client never sees the mess.",
    icon: (
      <>
        <rect x="3" y="4" width="8" height="7" rx="1.5" />
        <rect x="13" y="13" width="8" height="7" rx="1.5" />
        <path d="M11 7.5h4.5a2 2 0 0 1 2 2V13" />
        <path d="M15.5 10.5 17.5 13l2-2.5" />
      </>
    )
  },
  {
    title: "Deploy straight from your repo",
    body:
      "Point a Next.js, Nuxt or Node app at a Git branch and every push builds and deploys. Bring a Dockerfile or a compose file instead if the app needs one.",
    icon: (
      <>
        <circle cx="6.5" cy="6" r="2.5" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="17.5" cy="12" r="2.5" />
        <path d="M6.5 8.5v7" />
        <path d="M9 6h4a2 2 0 0 1 2 2v2" />
      </>
    )
  },
  {
    title: "One-click cache control",
    wordpressOnly: true,
    body:
      "Object cache, page cache, Redis, Elementor's compiled CSS and your Cloudflare edge — cleared together, with a report of what was actually cleared rather than a hopeful message.",
    icon: (
      <>
        <path d="M4 7.5 12 3.5l8 4-8 4-8-4Z" />
        <path d="M4 12.5l8 4 8-4" />
        <path d="M4 17l8 4 8-4" />
      </>
    )
  },
  {
    title: "Plugins, malware and privacy mode",
    wordpressOnly: true,
    body:
      "A live inventory of every plugin and version, scheduled malware scans, and a password in front of the whole site while it is still being built — so clients can review it before search engines find it.",
    icon: (
      <>
        <path d="M12 3.5 19 6v5.5c0 4-3 7.4-7 9-4-1.6-7-5-7-9V6l7-2.5Z" />
        <path d="m9.2 12 2 2 3.6-3.8" />
      </>
    )
  },
  {
    title: "Client access, scoped properly",
    body:
      "Invite a client to their own project with a role that lets them look and little else. Per-site SFTP credentials, chrooted to that site's files and nobody else's.",
    icon: (
      <>
        <circle cx="9" cy="8.5" r="3" />
        <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
        <path d="M16.5 11.5h4" />
        <path d="M18.5 9.5v4" />
      </>
    )
  }
];

const STEPS = [
  {
    n: "01",
    title: "You send credentials",
    body: "Current host, a backup file, or read access to the Git repo."
  },
  {
    n: "02",
    title: "We rebuild it on a staging URL",
    body: "Usually within [YOUR TURNAROUND]. You check it over properly."
  },
  {
    n: "03",
    title: "We cut the DNS over",
    body: "At a time you pick. The old host stays untouched as a fallback."
  }
];

/**
 * TLD prices for the hero's search box.
 *
 * From the unauthenticated, unthrottled pricing endpoint, so this costs the
 * availability rate limit nothing. Failure degrades to an empty list and the
 * search box simply omits the price row — it never blocks the page or invents
 * a number.
 */
async function loadTldPrices() {
  if (!isPorkbunConfigured()) return [];
  try {
    const prices = await getPricesForTlds(SUGGESTED_TLDS);
    return prices.map((entry) => ({
      tld: entry.tld,
      registrationDisplay: formatCents(entry.registrationCents),
      transferDisplay: formatCents(entry.transferCents)
    }));
  } catch {
    return [];
  }
}

export default async function HostingPage() {
  const email = contactEmail();
  const tldPrices = await loadTldPrices();

  return (
    <div className={publicPage}>
      {/* nav */}
      <header className="hosting-nav">
        <Link href="/hosting" className="hosting-brand">
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={30} height={30} />
          <span>Jongo</span>
        </Link>
        <div className="hosting-nav__actions">
          <Link href="/domains" className="hosting-nav__signin">
            Domains
          </Link>
          <Link href="/pricing" className="hosting-nav__signin">
            Pricing
          </Link>
          <Link href="/auth/login" className="hosting-nav__signin">
            Sign in
          </Link>
          <Link href="/auth/register" className={cx(btnPrimary, "px-4 py-[9.5px] text-[14.5px]")}>
            Get started
          </Link>
        </div>
      </header>

      {/* hero */}
      <section className="hosting-hero">
        <div className="hosting-hero__copy">
          {/* The pill carries the domain proposition; the fix-it-free promo gets
              its own card below rather than being said twice in a row. */}
          <span className="hosting-pill">
            <span className="hosting-pill__dot" aria-hidden />
            Register or transfer — WHOIS privacy included, free
          </span>
          <h1 className="hosting-h1">Find your domain. We&apos;ll host it too.</h1>
          <p className="hosting-lede">
            Register or transfer a domain in about a minute, then point it at managed
            hosting — WordPress, Next.js, Nuxt, Node — with nightly offsite backups.
          </p>

          <div className="mt-[22px]">
            <DomainSearch initialPrices={tldPrices} />
          </div>

          <div className="hosting-cta-row mt-5">
            <Link href="/domains/transfer" className={cx(btnSecondary, "px-5 py-3 text-[15px]")}>
              Transfer a domain in
            </Link>
            <Link href="#migration" className={cx(btnSecondary, "px-5 py-3 text-[15px]")}>
              Move my hosting
            </Link>
          </div>
          <p className="hosting-fineprint">
            Free WHOIS privacy · Transfers include a year&apos;s renewal · Free migration
          </p>
        </div>

        {/* The real dashboard, in miniature — same tokens as the app itself. */}
        <HeroDashboardPreview />
      </section>

      {/* The fix-it-free promo, stated properly rather than only as a pill. */}
      <section className="hosting-section py-2">
        <div className={cx(cardHealthy, "flex items-center justify-between gap-[18px] flex-wrap px-6 py-5")}>
          <div className="min-w-[260px] flex-[1_1_420px]">
            <h2 className="hosting-h2 text-[22px] mb-1.5">
              Need something fixed on your site today?
            </h2>
            <p className="hosting-body m-0 text-[15px]">
              Transfer your hosting to us and we will fix it for free as part of moving you
              in — the white screen, the failed update, the plugin conflict, the site that
              will not load. You do not pay us to repair what you are bringing over.
            </p>
          </div>
          <Link
            href="/contact"
            className={cx(btnPrimary, "px-6 py-[13px] text-[15.5px] shrink-0")}
          >
            Tell us what is broken
          </Link>
        </div>
      </section>


      {/* features */}
      <section className="hosting-section">
        <h2 className="hosting-h2">What every site gets</h2>
        <p className="hosting-sub">
          Not add-ons, not a higher tier. On from the day it moves in — whatever it is built with.
        </p>
        <div className="hosting-grid-3">
          {FEATURES.map((feature) => (
            <article key={feature.title} className={cx(card, "p-[22px]")}>
              <Icon>{feature.icon}</Icon>
              <h3 className="hosting-h3">
                {feature.title}
                {feature.wordpressOnly ? <span className="hosting-tag">WordPress</span> : null}
              </h3>
              <p className="hosting-body">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* pricing */}
      <section className="hosting-pricing" id="pricing">
        <div className="hosting-section py-[66px]">
          <h2 className="hosting-h2">Simple plans, priced per project</h2>
          <p className="hosting-sub">
            Move up or down at any time. Agency volume pricing starts at ten projects.
          </p>
          <div className="hosting-grid-3 items-start">
            {PLANS.map((plan) => (
              <article
                key={plan.id}
                className={cx(
                  card,
                  "p-[26px] relative",
                  plan.featured && "border-2 border-solid border-[#8dc267] shadow-featured"
                )}
              >
                {plan.featured ? <span className="hosting-badge">Most agencies start here</span> : null}
                <img src={plan.icon} alt="" width={42} height={42} className="block mb-4" />
                <h3 className="hosting-plan__name">{plan.name}</h3>
                <p className="hosting-plan__blurb">{plan.blurb}</p>
                <p className="hosting-plan__price">
                  <span>{plan.price}</span>
                  <small>/month</small>
                </p>
                <Link
                  href={`/auth/register?plan=${plan.id}`}
                  className={cx(plan.featured ? btnPrimary : btnSecondary, "flex px-[18px] py-3 text-[14.5px] mb-5")}
                >
                  Choose {plan.name}
                </Link>
                <ul className="hosting-plan__features">
                  {plan.features.map((item) => (
                    <li key={item}>
                      <span aria-hidden>✓</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <p className="hosting-fineprint mt-[22px]">
            Prices in {CURRENCY_LABEL}, excluding tax.{" "}
            <Link href="/pricing">Compare every feature</Link>, or{" "}
            <Link href="/contact">ask about agency pricing</Link> for more than 20 projects.
          </p>
        </div>
      </section>

      {/* migration */}
      <section className="hosting-section hosting-migration" id="migration">
        <div>
          <h2 className="hosting-h2">We move it. You keep working.</h2>
          <p className="hosting-body text-base mb-5">
            Send us access to your current host — or the repo, if it is an app — and we do the move,
            including the database, the uploads and the DNS cutover. Nothing goes live until you have
            seen it running on a staging URL and told us it looks right.
          </p>
          <Link href="/auth/register" className={cx(btnPrimary, "px-5 py-3 text-[15px]")}>
            Start a migration
          </Link>
        </div>
        <div className="hosting-steps">
          {STEPS.map((step) => (
            <div key={step.n} className={cx(card, "px-5 py-[18px]")}>
              <span className="hosting-steps__n">{step.n}</span>
              <div>
                <p className="hosting-steps__title">{step.title}</p>
                <p className="hosting-body">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* closing */}
      <section className="hosting-section pt-0">
        <div className="hosting-closing">
          <div>
            <h2 className="hosting-h2 text-[27px] mb-[9px]">
              Move your first project this week.
            </h2>
            <p className="hosting-body text-[15.5px]">
              Set up an account in a couple of minutes. We will handle the migration from there.
            </p>
          </div>
          <Link href="/auth/register" className={cx(btnPrimary, "px-6 py-[13px] text-[15.5px] shrink-0")}>
            Create your account
          </Link>
        </div>
      </section>

      <footer className="hosting-footer">
        <div>
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={22} height={22} />
          <span>© 2026 Jongo. All rights reserved.</span>
        </div>
        <div className="hosting-footer__links">
          <Link href="/auth/login">Sign in</Link>
          <a href="#">Terms</a>
          <a href="#">Privacy</a>
          <Link href="/contact">Contact</Link>
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
        </div>
      </footer>
    </div>
  );
}
