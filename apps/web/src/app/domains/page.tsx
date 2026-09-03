import type { Metadata } from "next";
import Link from "next/link";
import DomainSearch from "@/components/DomainSearch";
import { SUGGESTED_TLDS, formatCents, parseDomain } from "@/lib/domain-search";
import { checkAvailability, getPricesForTlds, getTldPricing, isPorkbunConfigured } from "@/lib/porkbun";
import { COMPANY_NAME, contactEmail, currentYear } from "@/lib/public-site";
import { btnPrimary, btnSecondary, card, cardHealthy, cx, noticeWarn, publicPage } from "@/lib/public-ui";

/**
 * Public domain registration page.
 *
 * Arriving with `?domain=` — which is how the homepage hero hands off a name
 * someone just searched — this checks that one name and shows the price. The
 * check is almost always free: the same domain was checked seconds ago on the
 * homepage and the result is still in the five-minute cache (lib/porkbun.ts).
 *
 * ## Why there is no "buy now" button here
 *
 * Registration calls Porkbun's `domain/create`, which draws on JONGO'S account
 * balance — the registrar bills us, not the visitor. This codebase has no
 * payment integration, so a public button that placed a real order would let
 * anyone spend the company's registrar credit. That is not a hypothetical: the
 * only reason it is harmless today is that the configured keys are sandbox
 * ones, and the same code with live keys is an open faucet.
 *
 * So the public path funnels to signup with the domain carried through, the
 * same way `?plan=` already works, and the order itself lives behind
 * /api/domains/order, which requires an authenticated admin. When billing is
 * wired up, the button belongs here — not before.
 */

export const metadata: Metadata = {
  title: "Register a domain | Jongo",
  description:
    "Register a domain and host it in the same place. Free WHOIS privacy, transfers include a year's renewal, and free migration of your existing site."
};

export const dynamic = "force-dynamic";

async function loadPrices() {
  if (!isPorkbunConfigured()) return [];
  try {
    const prices = await getPricesForTlds(SUGGESTED_TLDS);
    return prices.map((entry) => ({
      tld: entry.tld,
      registrationDisplay: formatCents(entry.registrationCents),
      transferDisplay: formatCents(entry.transferCents),
      renewalDisplay: formatCents(entry.renewalCents)
    }));
  } catch {
    return [];
  }
}

type Params = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function DomainsPage({ searchParams }: Params) {
  const resolved = (await searchParams) ?? {};
  const requestedRaw = resolved.domain;
  const requested = (Array.isArray(requestedRaw) ? requestedRaw[0] : requestedRaw) ?? "";

  const prices = await loadPrices();
  const email = contactEmail();

  // Only check when a name was actually handed over, so an idle visit to
  // /domains costs nothing against the one-per-ten-seconds limit.
  const knownTlds = requested ? await getTldPricing().catch(() => new Map()) : new Map();
  const parsed = requested ? parseDomain(requested, knownTlds.keys()) : null;
  const availability = parsed ? await checkAvailability(parsed.domain) : null;

  return (
    <div className={publicPage}>
      <header className="hosting-nav">
        <Link href="/hosting" className="hosting-brand">
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={30} height={30} />
          <span>Jongo</span>
        </Link>
        <div className="hosting-nav__actions">
          <Link href="/domains/transfer" className="hosting-nav__signin">
            Transfers
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
          Register a domain, host it in the same place.
        </h1>
        <p className="hosting-lede max-w-[620px] mx-auto">
          One dashboard for the domain and the site behind it. WHOIS privacy is free, and
          nothing renews at a surprise price — the renewal is on the card before you buy.
        </p>
      </section>

      <section className="hosting-section pt-0 pb-10">
        <div className={cx(card, "p-[22px] max-w-[760px] mx-auto")}>
          <DomainSearch initialPrices={prices} />
        </div>

        {availability && parsed ? (
          <div className="max-w-[760px] mx-auto mt-[18px]">
            <RequestedDomain domain={parsed.domain} availability={availability} />
          </div>
        ) : null}
      </section>

      {/* price table */}
      {prices.length > 0 ? (
        <section className="hosting-pricing">
          <div className="hosting-section py-12">
            <h2 className="hosting-h2">What each ending costs</h2>
            <p className="hosting-sub">
              First year, renewal and transfer-in, straight from the registry. Transfers include
              a year&apos;s renewal, so moving a domain here extends it rather than just relocating it.
            </p>
            <div className="pricing-table__scroll">
              <table className="pricing-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="pricing-table__srlabel">Ending</span>
                    </th>
                    <th scope="col">First year</th>
                    <th scope="col">Renewal</th>
                    <th scope="col">Transfer in</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((entry) => (
                    <tr key={entry.tld}>
                      <th scope="row">.{entry.tld}</th>
                      <td>{entry.registrationDisplay}</td>
                      <td>{entry.renewalDisplay}</td>
                      <td>{entry.transferDisplay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hosting-fineprint mt-[18px]">
              Prices in US dollars, excluding tax. Hundreds of other endings are available — ask
              and we will quote it.
            </p>
          </div>
        </section>
      ) : null}

      <section className="hosting-section pt-14">
        <h2 className="hosting-h2">What comes with every domain</h2>
        <div className="hosting-grid-3">
          {[
            {
              title: "WHOIS privacy, free",
              body:
                "Your name, address and email stay out of the public WHOIS record. Some registrars charge yearly for this; it is included here."
            },
            {
              title: "DNS you can actually edit",
              body:
                "A records, CNAMEs, MX, TXT — editable in the dashboard, and pre-pointed at your Jongo app if you host here too."
            },
            {
              title: "No renewal surprises",
              body:
                "The renewal price is shown next to the first-year price before you buy. Renewals are never quietly higher than the number you agreed to."
            }
          ].map((item) => (
            <article key={item.title} className={cx(card, "p-[22px]")}>
              <h3 className="contact-route__title">{item.title}</h3>
              <p className="hosting-body">{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="hosting-section pt-0">
        <div className="hosting-closing">
          <div>
            <h2 className="hosting-h2 text-[27px] mb-[9px]">
              Already own the domain?
            </h2>
            <p className="hosting-body text-[15.5px]">
              Move it here and the transfer adds a year to whatever is left on it. If the site
              itself is broken, we fix that for free as part of moving you in.
            </p>
          </div>
          <Link href="/domains/transfer" className={cx(btnPrimary, "px-6 py-[13px] text-[15.5px] shrink-0")}>
            Transfer a domain
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
          <Link href="/domains/transfer">Transfers</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/contact">Contact</Link>
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
        </div>
      </footer>
    </div>
  );
}

/**
 * The handed-over domain's status.
 *
 * Three states, matching the API exactly. The `unknown` case gets no price, no
 * tick and no call to action — a domain we could not check is not reported as
 * anything.
 */
function RequestedDomain({
  domain,
  availability
}: {
  domain: string;
  availability: Awaited<ReturnType<typeof checkAvailability>>;
}) {
  const shell = cx(card, "px-[22px] py-5");

  if (availability.state === "available") {
    return (
      <div className={cx(cardHealthy, "px-[22px] py-5")}>
        <div className="flex justify-between items-center gap-4 flex-wrap">
          <div>
            <p className="m-0 text-[1.15rem] font-semibold">{domain} is available</p>
            <p className="mt-1 mb-0 text-muted text-[0.92rem]">
              {availability.priceDisplay} for the first year, then {formatCents(availability.renewalCents)} a
              year. WHOIS privacy included.
              {availability.premium ? " This is a premium name, priced by the registry." : ""}
            </p>
          </div>
          {/* Funnels to signup rather than ordering: see the note at the top of
              this file — there is no billing, so no public button may spend the
              company's registrar balance. */}
          <Link
            href={`/auth/register?domain=${encodeURIComponent(domain)}`}
            className={cx(btnPrimary, "px-[22px] py-[13px] text-[15px] shrink-0")}
          >
            Create an account to claim it
          </Link>
        </div>
        <p className="mt-3.5 mb-0 text-[0.86rem] text-muted">
          We hold nothing until it is registered — a domain is only yours once the order goes
          through, so if it matters, do it now rather than later.
        </p>
        {availability.sandbox ? (
          <p className={cx(noticeWarn, "mt-3 mb-0 px-3 py-[9px] text-[0.84rem]")}>
            <strong>Test mode.</strong> Domain search is pointed at the registrar&apos;s sandbox, so
            this result is not a real registry answer and no domain can actually be registered yet.
          </p>
        ) : null}
      </div>
    );
  }

  if (availability.state === "taken") {
    return (
      <div className={shell}>
        <p className="m-0 text-[1.15rem] font-semibold">{domain} is already registered</p>
        <p className="mt-1 mb-0 text-muted text-[0.92rem]">
          If it is yours, transferring it here costs {availability.transferDisplay} and adds a year to
          whatever time is left on it.
        </p>
        <div className="flex gap-2.5 flex-wrap mt-3.5">
          <Link
            href={`/domains/transfer?domain=${encodeURIComponent(domain)}`}
            className={cx(btnPrimary, "px-[18px] py-[11px] text-[14.5px]")}
          >
            Transfer it here
          </Link>
          <Link href="/domains" className={cx(btnSecondary, "px-[18px] py-[11px] text-[14.5px]")}>
            Try another name
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={cx(card, "px-[22px] py-5 border-warn-border bg-[#fffbf2]")}>
      <p className="m-0 text-[1.05rem] font-semibold">
        We could not check {domain} just now
      </p>
      <p className="mt-1 mb-0 text-muted text-[0.92rem]">
        {availability.message}
        {availability.reason === "rate_limited"
          ? " Domain checks are limited by the registry, so this clears in a few seconds."
          : ""}
      </p>
      <p className="mt-3 mb-0 text-[0.88rem] text-muted">
        Rather than guess, we would sooner say we do not know — search again in a moment.
      </p>
    </div>
  );
}
