/**
 * The handful of real-world facts the public pages state.
 *
 * In one place because they appear on both /hosting and /contact, and because
 * the contact address must be the SAME one the contact API actually delivers
 * to — showing an address that nothing routes to is the kind of quietly wrong
 * detail nobody notices until a client emails into a void.
 *
 * Server-only: these read process.env, so a client component takes them as
 * props rather than importing this.
 */

export const COMPANY_NAME = "Jongo";

/** Support response time, as stated to customers. */
export const RESPONSE_TIME = "10 minutes";

/** Displayed on pricing. The plan figures themselves are still placeholders. */
export const CURRENCY_LABEL = "US dollars";

/** The public brand domain. */
export const SITE_DOMAIN = "jongo.app";

/**
 * The address shown to the public.
 *
 * DELIBERATELY does not fall back to SMTP_FROM. It used to, on the reasoning
 * that the displayed address should match the one mail is delivered to — but
 * SMTP_FROM is an internal ops mailbox on a different domain, so that fallback
 * published an internal address on three public pages. Delivery and display are
 * different concerns: api/contact may fall back for DELIVERY, where nobody sees
 * it; this must never guess what to print.
 *
 * Override with PUBLIC_CONTACT_EMAIL. Empty resolves to nothing and the pages
 * omit the address rather than render a dead mailto link.
 */
export function contactEmail(): string {
  const configured = (process.env.PUBLIC_CONTACT_EMAIL || "").trim();
  return configured || DEFAULT_PUBLIC_EMAIL;
}

/**
 * Confirm this mailbox exists before the site is public — a printed address
 * that bounces is worse than none, and the pages handle none gracefully.
 */
const DEFAULT_PUBLIC_EMAIL = `support@${SITE_DOMAIN}`;

/**
 * Baked at build time, which is fine for a copyright line and means it moves
 * on the next deploy rather than needing a dynamic render for a footer.
 */
export function currentYear(): number {
  return new Date().getFullYear();
}
