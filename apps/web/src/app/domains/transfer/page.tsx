import type { Metadata } from "next";
import Link from "next/link";
import { SUGGESTED_TLDS, formatCents, parseDomain } from "@/lib/domain-search";
import { getPricesForTlds, getTldPricing, isPorkbunConfigured } from "@/lib/porkbun";
import { COMPANY_NAME, RESPONSE_TIME, contactEmail, currentYear } from "@/lib/public-site";
import { btnPrimary, btnSecondary, card, cardHealthy, cx, pill, publicPage } from "@/lib/public-ui";

/**
 * Public domain transfer page.
 *
 * Transfers are the higher-intent half of this: someone with a domain
 * elsewhere already has a site, which is the customer worth having. It is also
 * where the "we will fix it free" promo actually belongs — the people moving a
 * domain are the people whose current setup is annoying them.
 *
 * ## Deliberately no availability check on this page
 *
 * A transfer needs an auth code from the losing registrar, which means a
 * conversation, not a checkout. Checking availability would spend one of the
 * account's six-per-minute checks to tell someone what they already know
 * (their own domain is registered — to them). So this page quotes transfer
 * PRICES from the unthrottled pricing endpoint and collects the request.
 *
 * The order itself goes through /api/domains/order, which is auth-gated: see
 * the note in app/domains/page.tsx for why nothing public may place an order
 * while there is no billing integration.
 */

export const metadata: Metadata = {
  title: "Transfer a domain | Jongo",
  description:
    "Move your domain to Jongo. Transfers include a year's renewal, WHOIS privacy is free, and we fix what is broken on your site as part of moving you in."
};

export const dynamic = "force-dynamic";

const STEPS = [
  {
    title: "Unlock it where it lives now",
    body:
      "In your current registrar's control panel, turn off the transfer lock (sometimes called registrar lock or clientTransferProhibited) and make sure the WHOIS email on the domain is one you can read."
  },
  {
    title: "Get the auth code",
    body:
      "Also called an EPP code or authorization code. Your current registrar will show it, or email it to the WHOIS address. It is a one-time password for moving the domain."
  },
  {
    title: "Send it to us",
    body:
      "Give us the domain and the code and we start the transfer. You will get an approval email from the registry — click it and the move completes, usually within a few hours."
  },
  {
    title: "Nothing goes down",
    body:
      "Your DNS records come across as they are, so the site keeps resolving throughout. We only change what is pointing where once you ask us to."
  }
];

const FAQ = [
  {
    q: "Will my site go offline during the transfer?",
    a: "No. A transfer moves who bills you for the domain, not where it points. Your existing DNS records are preserved, and we do not change what the domain resolves to unless you ask us to move the hosting as well."
  },
  {
    q: "Do I lose the time left on my registration?",
    a: "The opposite — a transfer adds a year on top of whatever is left. If your domain had eight months to run, it will have twenty months after the transfer completes."
  },
  {
    q: "Why is my domain refusing to transfer?",
    a: "Almost always one of three things: it is still locked at the current registrar, it was registered or last transferred fewer than 60 days ago (a registry rule, not ours), or the auth code has expired. Send us the error and we will tell you which."
  },
  {
    q: "Can you move the hosting at the same time?",
    a: "Yes, and that is usually the point. We migrate the site, set up staging and backups, and cut the DNS over when the copy on our side is verified working — so the switch is a DNS change, not a gamble."
  }
];

async function loadTransferPrices() {
  if (!isPorkbunConfigured()) return [];
  try {
    const prices = await getPricesForTlds(SUGGESTED_TLDS);
    return prices.map((entry) => ({
      tld: entry.tld,
      transferDisplay: formatCents(entry.transferCents)
    }));
  } catch {
    return [];
  }
}

type Params = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function DomainTransferPage({ searchParams }: Params) {
  const resolved = (await searchParams) ?? {};
  const raw = resolved.domain;
  const requested = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  const prices = await loadTransferPrices();
  const email = contactEmail();

  // Parsed only to echo it back safely and to look up the right price — no
  // availability call, for the reason in the file header.
  const knownTlds = requested ? await getTldPricing().catch(() => new Map()) : new Map();
  const parsed = requested ? parseDomain(requested, knownTlds.keys()) : null;
  // Priced from the FULL registry list, not the six endings shown in the strip
  // below: someone transferring a .co.uk should see the .co.uk price, not "we
  // will quote it" just because that ending is not one of the suggestions.
  const quotedCents = parsed ? (knownTlds.get(parsed.tld)?.transferCents ?? null) : null;
  const quotedDisplay = quotedCents === null ? null : formatCents(quotedCents);

  return (
    <div className={publicPage}>
      <header className="hosting-nav">
        <Link href="/hosting" className="hosting-brand">
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={30} height={30} />
          <span>Jongo</span>
        </Link>
        <div className="hosting-nav__actions">
          <Link href="/domains" className="hosting-nav__signin">
            Register
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

      <section className="pricing-head">
        <h1 className="hosting-h1 text-[clamp(1.9rem,1.3rem+2vw,2.6rem)]">
          Move your domain. Keep your site up.
        </h1>
        <p className="hosting-lede max-w-[640px] mx-auto">
          A transfer adds a year to your registration rather than restarting it, WHOIS privacy is
          free, and your DNS comes across unchanged — so nothing goes dark while it happens.
        </p>
      </section>

      {/* The promo, front and centre — this is the page its audience lands on. */}
      <section className="hosting-section pt-0 pb-9">
        <div className={cx(cardHealthy, "max-w-[820px] mx-auto px-[26px] py-6")}>
          <div className="flex items-center justify-between gap-[18px] flex-wrap">
            <div className="flex-[1_1_420px] min-w-[260px]">
              <h2 className="hosting-h2 text-[23px] mb-[7px]">
                Something broken right now? We fix it free.
              </h2>
              <p className="hosting-body m-0 text-[15px]">
                Transfer your hosting to us and the repair is part of moving in, not a separate
                invoice — the white screen of death, the update that took the site down, the
                plugin conflict, the checkout that stopped working. Tell us what is wrong and we
                will reply within {RESPONSE_TIME}.
              </p>
            </div>
            <Link href="/contact" className={cx(btnPrimary, "px-6 py-[13px] text-[15.5px] shrink-0")}>
              Tell us what is broken
            </Link>
          </div>
        </div>
      </section>

      {parsed ? (
        <section className="hosting-section pt-0 pb-9">
          <div className={cx(card, "max-w-[820px] mx-auto px-6 py-[22px]")}>
            <p className="m-0 text-[1.1rem] font-semibold">
              Transferring {parsed.domain}
            </p>
            <p className="mt-[5px] mb-0 text-muted text-[0.94rem]">
              {quotedDisplay
                ? `${quotedDisplay}, which includes a year's renewal on top of whatever is left.`
                : "We will quote the transfer for this ending when you get in touch."}
            </p>
            <p className="mt-3 mb-0 text-[0.9rem] text-muted">
              Have the auth code from your current registrar ready — step two below explains where
              to find it.
            </p>
            <div className="flex gap-2.5 flex-wrap mt-4">
              <Link
                href={`/contact?subject=${encodeURIComponent(`Transfer ${parsed.domain}`)}`}
                className={cx(btnPrimary, "px-5 py-3 text-[14.5px]")}
              >
                Start this transfer
              </Link>
              <Link href="/domains" className={cx(btnSecondary, "px-5 py-3 text-[14.5px]")}>
                Register a different name
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {/* how it works */}
      <section className="hosting-pricing">
        <div className="hosting-section py-12">
          <h2 className="hosting-h2">How a transfer works</h2>
          <p className="hosting-sub">
            Four steps, and we do the awkward ones with you. Most transfers complete the same day.
          </p>
          <div className="hosting-grid-3 items-start">
            {STEPS.map((step, index) => (
              <article key={step.title} className={cx(card, "p-[22px]")}>
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-nav-active border border-solid border-sidebar-active-border text-sidebar-item-active text-[0.85rem] font-bold mb-3">
                  {index + 1}
                </span>
                <h3 className="contact-route__title">{step.title}</h3>
                <p className="hosting-body">{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* transfer prices */}
      {prices.length > 0 ? (
        <section className="hosting-section pt-14">
          <h2 className="hosting-h2">Transfer prices</h2>
          <p className="hosting-sub">
            Each one includes a year&apos;s renewal added to your existing registration.
          </p>
          <div className="flex flex-wrap gap-2.5 justify-center">
            {prices.map((entry) => (
              <span key={entry.tld} className={cx(pill, "gap-2 px-4 py-2.5 text-[14.5px]")}>
                <strong className="font-semibold">.{entry.tld}</strong>
                <span className="text-muted">{entry.transferDisplay}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {/* faq */}
      <section className="hosting-section pt-14">
        <h2 className="hosting-h2">Questions people actually ask</h2>
        <div className="pricing-faq">
          {FAQ.map((item) => (
            <div key={item.q} className={cx(card, "px-[22px] py-5")}>
              <h3 className="contact-route__title">{item.q}</h3>
              <p className="hosting-body">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="hosting-section pt-2">
        <div className="hosting-closing">
          <div>
            <h2 className="hosting-h2 text-[27px] mb-[9px]">
              Moving more than one?
            </h2>
            <p className="hosting-body text-[15.5px]">
              Send us the list. We do agency migrations in batches — domains, sites and databases
              together — and there is a rate card for anything over twenty.
            </p>
          </div>
          <Link href="/contact" className={cx(btnPrimary, "px-6 py-[13px] text-[15.5px] shrink-0")}>
            Talk to us
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
          <Link href="/domains">Register</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/contact">Contact</Link>
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
        </div>
      </footer>
    </div>
  );
}
