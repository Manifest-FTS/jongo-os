import type { Metadata } from "next";
import Link from "next/link";
import ContactForm from "@/components/ContactForm";
import { COMPANY_NAME, RESPONSE_TIME, contactEmail, currentYear } from "@/lib/public-site";

/**
 * Public contact page.
 *
 * Same chrome and tokens as /hosting, listed in middleware's PUBLIC_PATHS, and
 * it looks up nothing — the only dynamic part is the form, which posts to
 * /api/contact.
 */

export const metadata: Metadata = {
  title: "Contact | Jongo",
  description:
    "Talk to us about migrating WordPress, Next.js, Nuxt or Node sites onto managed hosting — or ask about agency pricing."
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

function buildRoutes(email: string): { title: string; body: string; action: React.ReactNode }[] {
  return [
  {
    title: "Moving a site over",
    body: "Tell us how many, what they are built with and where they live now. We do the migration, including the DNS cutover.",
    action: <span className="contact-route__meta">Use the form — it reaches the team that does the migrations.</span>
  },
  {
    title: "Already hosting with us",
    body: "Support requests are fastest from inside your dashboard, where we can see the site you are asking about.",
    action: (
      <Link href="/auth/login" className="auth-inline-link">
        Sign in to your account
      </Link>
    )
  },
  {
    title: "Agency and volume pricing",
    body: "More than 20 projects, or reselling to your own clients? There is a different rate card for that.",
    action: email ? <a href={`mailto:${email}`}>{email}</a> : <span className="contact-route__meta">Use the form.</span>
  }
  ];
}

export default function ContactPage() {
  const email = contactEmail();
  const routes = buildRoutes(email);

  return (
    <div style={{ background: PAGE_BG, minHeight: "100vh" }}>
      <header className="hosting-nav">
        <Link href="/hosting" className="hosting-brand">
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={30} height={30} />
          <span>Jongo</span>
        </Link>
        <div className="hosting-nav__actions">
          <Link href="/pricing" className="hosting-nav__signin">
            Pricing
          </Link>
          <Link href="/auth/login" className="hosting-nav__signin">
            Sign in
          </Link>
          <Link
            href="/hosting#pricing"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "8px",
              padding: "9.5px 16px",
              fontSize: "14.5px",
              fontWeight: 600,
              lineHeight: 1,
              background: "linear-gradient(180deg, #a8d287 0%, #8dc267 100%)",
              color: "#16231f",
              border: "1px solid transparent",
              textDecoration: "none"
            }}
          >
            See plans
          </Link>
        </div>
      </header>

      <section className="contact-hero">
        <div className="contact-hero__copy">
          <h1 className="hosting-h1" style={{ fontSize: "clamp(1.9rem, 1.3rem + 2vw, 2.75rem)" }}>
            Tell us what you need moved.
          </h1>
          <p className="hosting-lede">
            A real person reads these. If you are weighing up a migration, say how many sites you have
            and what they are built with — that is usually enough for us to give you a straight answer
            on effort and cost.
          </p>

          <div className="contact-routes">
            {routes.map((route) => (
              <div key={route.title} style={{ ...CARD, padding: "18px 20px" }}>
                <h3 className="contact-route__title">{route.title}</h3>
                <p className="hosting-body">{route.body}</p>
                <div className="contact-route__action">{route.action}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ ...CARD, padding: "28px" }}>
          <ContactForm contactEmail={email} responseTime={RESPONSE_TIME} />
        </div>
      </section>

      <footer className="hosting-footer">
        <div>
          <img src="/assets/images/jongo-logomark-color.png" alt="" width={22} height={22} />
          <span>© {currentYear()} {COMPANY_NAME}. All rights reserved.</span>
        </div>
        <div className="hosting-footer__links">
          <Link href="/hosting">Hosting</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/auth/login">Sign in</Link>
          <a href="#">Terms</a>
          <a href="#">Privacy</a>
        </div>
      </footer>
    </div>
  );
}
