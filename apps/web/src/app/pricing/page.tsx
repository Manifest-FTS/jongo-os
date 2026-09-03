import type { Metadata } from "next";
import Link from "next/link";
import { COMPARISON, PLANS, PRICING_FAQ, type ComparisonValue } from "@/lib/public-plans";
import { COMPANY_NAME, CURRENCY_LABEL, contactEmail, currentYear } from "@/lib/public-site";

/**
 * Public pricing page.
 *
 * The plan cards render from the same lib/public-plans source /hosting uses, so
 * a price can never be right on one page and stale on the other. Everything
 * below the cards — the comparison table and the FAQ — is what this page adds
 * over the landing page's pricing section.
 */

export const metadata: Metadata = {
  title: "Pricing | Jongo",
  description:
    "Managed hosting priced per project, for WordPress, Next.js, Nuxt and Node. Nightly offsite backups and free migration on every plan."
};

const PAGE_BG =
  "radial-gradient(circle at 12% 18%, rgba(212, 175, 55, 0.20), transparent 36%), " +
  "radial-gradient(circle at 88% 10%, rgba(255, 47, 176, 0.12), transparent 38%), " +
  "linear-gradient(180deg, #f9faf9 0%, #eef1f1 100%)";

const CARD: React.CSSProperties = {
  background: "linear-gradient(180deg, #ffffff 0%, #fbfcfc 100%)",
  border: "1px solid var(--border)",
  borderRadius: "14px",
  boxShadow: "var(--shadow)"
};

const PRIMARY: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "8px",
  padding: "12px 18px",
  fontSize: "14.5px",
  fontWeight: 600,
  lineHeight: 1,
  background: "linear-gradient(180deg, #a8d287 0%, #8dc267 100%)",
  color: "#16231f",
  border: "1px solid transparent",
  textDecoration: "none"
};

const SECONDARY: React.CSSProperties = {
  ...PRIMARY,
  background: "#f5f8f4",
  color: "#28412f",
  border: "1px solid var(--border)"
};

/** A yes/no renders as a mark; anything else is a limit, printed as written. */
function Cell({ value }: { value: ComparisonValue }) {
  if (value === true) {
    return (
      <span className="pricing-yes" aria-label="Included">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 12.5 4.5 4.5L19 7" />
        </svg>
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="pricing-no" aria-label="Not included">
        —
      </span>
    );
  }
  return <span className="pricing-value">{value}</span>;
}

export default function PricingPage() {
  const email = contactEmail();

  return (
    <div style={{ background: PAGE_BG, minHeight: "100vh" }}>
      <header className="hosting-nav">
        <Link href="/hosting" className="hosting-brand">
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={30} height={30} />
          <span>Jongo</span>
        </Link>
        <div className="hosting-nav__actions">
          <Link href="/contact" className="hosting-nav__signin">
            Contact
          </Link>
          <Link href="/auth/login" className="hosting-nav__signin">
            Sign in
          </Link>
          <Link href="/auth/register" style={{ ...PRIMARY, display: "inline-flex", padding: "9.5px 16px" }}>
            Get started
          </Link>
        </div>
      </header>

      <section className="pricing-head">
        <h1 className="hosting-h1" style={{ fontSize: "clamp(1.9rem, 1.3rem + 2vw, 2.75rem)" }}>
          Priced per project, not per surprise.
        </h1>
        <p className="hosting-lede" style={{ maxWidth: "620px", margin: "0 auto" }}>
          Every plan includes nightly offsite backups, free migration and the same dashboard. The
          difference is how many projects you run and how far back you can restore.
        </p>
      </section>

      <section className="hosting-section" style={{ paddingTop: 0, paddingBottom: "56px" }}>
        <div className="hosting-grid-3" style={{ alignItems: "start" }}>
          {PLANS.map((plan) => (
            <article
              key={plan.id}
              style={{
                ...CARD,
                padding: "26px",
                position: "relative",
                ...(plan.featured
                  ? { border: "2px solid #8dc267", boxShadow: "0 18px 38px rgba(21, 34, 34, 0.12)" }
                  : {})
              }}
            >
              {plan.featured ? <span className="hosting-badge">Most agencies start here</span> : null}
              <img src={plan.icon} alt="" width={42} height={42} style={{ display: "block", marginBottom: "16px" }} />
              <h2 className="hosting-plan__name">{plan.name}</h2>
              <p className="hosting-plan__blurb">{plan.blurb}</p>
              <p className="hosting-plan__price">
                <span>{plan.price}</span>
                <small>/month</small>
              </p>
              <Link
                href={`/auth/register?plan=${plan.id}`}
                style={{ ...(plan.featured ? PRIMARY : SECONDARY), marginBottom: "20px" }}
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
        <p className="hosting-fineprint" style={{ marginTop: "22px" }}>
          Prices in {CURRENCY_LABEL}, excluding tax. No minimum term.
        </p>
      </section>

      {/* comparison */}
      <section className="hosting-pricing">
        <div className="hosting-section" style={{ paddingTop: "56px", paddingBottom: "56px" }}>
          <h2 className="hosting-h2">Everything, side by side</h2>
          <p className="hosting-sub">
            Rows marked WordPress are conveniences that only exist for WordPress sites. Everything
            else applies whatever the project is built with.
          </p>

          <div className="pricing-table__scroll">
            <table className="pricing-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="pricing-table__srlabel">Feature</span>
                  </th>
                  {PLANS.map((plan) => (
                    <th key={plan.id} scope="col" className={plan.featured ? "is-featured" : undefined}>
                      <span className="pricing-table__plan">{plan.name}</span>
                      <span className="pricing-table__price">{plan.price}/mo</span>
                    </th>
                  ))}
                </tr>
              </thead>
              {COMPARISON.map((section) => (
                <tbody key={section.group}>
                  <tr className="pricing-table__group">
                    <th scope="colgroup" colSpan={4}>
                      {section.group}
                    </th>
                  </tr>
                  {section.rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">
                        {row.label}
                        {row.wordpressOnly ? <span className="hosting-tag">WordPress</span> : null}
                      </th>
                      <td>
                        <Cell value={row.seed} />
                      </td>
                      <td className={PLANS[1].featured ? "is-featured" : undefined}>
                        <Cell value={row.growth} />
                      </td>
                      <td>
                        <Cell value={row.summit} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </div>
      </section>

      {/* faq */}
      <section className="hosting-section" style={{ paddingTop: "64px" }}>
        <h2 className="hosting-h2">Questions people actually ask</h2>
        <div className="pricing-faq">
          {PRICING_FAQ.map((item) => (
            <div key={item.q} style={{ ...CARD, padding: "20px 22px" }}>
              <h3 className="contact-route__title">{item.q}</h3>
              <p className="hosting-body">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="hosting-section" style={{ paddingTop: 0 }}>
        <div className="hosting-closing">
          <div>
            <h2 className="hosting-h2" style={{ fontSize: "27px", marginBottom: "9px" }}>
              More than 20 projects?
            </h2>
            <p className="hosting-body" style={{ fontSize: "15.5px" }}>
              There is a separate rate card for agencies and resellers. Tell us roughly how many sites
              you look after and we will send it over.
            </p>
          </div>
          <Link href="/contact" style={{ ...PRIMARY, display: "inline-flex", padding: "13px 24px", fontSize: "15.5px", flexShrink: 0 }}>
            Ask about agency pricing
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
          <Link href="/contact">Contact</Link>
          <a href="#">Terms</a>
          <a href="#">Privacy</a>
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
        </div>
      </footer>
    </div>
  );
}
