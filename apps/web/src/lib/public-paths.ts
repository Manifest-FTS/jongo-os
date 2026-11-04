/**
 * Paths anyone may open without signing in. Matched by whole path segment
 * ("/pricing" covers "/pricing/x", not "/pricing-internal"); entries in
 * PREFIX_PUBLIC_PATHS also match a suffix (Next's generated share images).
 * "/" is decided separately in the middleware (exact match only).
 */
export const PUBLIC_PATHS = [
  // Crawler and AI-assistant files (app/robots.ts, sitemap.ts, llms*.txt,
  // opengraph-image). They redirected to the sign-in page before, so search
  // engines and assistants saw a login form instead of the site map.
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/llms-full.txt",
  "/opengraph-image",
  "/parked",
  // The public hosting signup page: the one surface someone with no account is
  // meant to land on, so it must never redirect to /auth/login.
  "/hosting",
  "/contact",
  "/api/contact",
  // GitHub's webhook deliveries carry no session; the route checks the
  // signature before doing anything.
  "/api/github/webhook",
  "/pricing",
  // Domain registration and transfer. Only search and retail prices answer an
  // anonymous visitor on the homepage; quotes, checkout, DNS and order fixes
  // need a signed-in user (they used to be public by prefix).
  "/domains",
  "/api/domains/search",
  "/api/domains/pricing",
  "/auth/login",
  "/auth/register",
  "/auth/error",
  "/auth/invite",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/api/auth",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/invites",
  "/api/health",
  "/api/coolify/connection",
  "/api/setup",
  // Internal collector route is secured by bearer token in its route handler.
  "/api/internal/wordpress-collector",
  // Git push webhooks: each request is verified against the app's own secret
  // in its handler (lib/git-webhooks.ts).
  "/api/webhooks/git"
];

const PREFIX_PUBLIC_PATHS = ["/opengraph-image"];

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    PREFIX_PUBLIC_PATHS.some((p) => pathname.startsWith(p))
  );
}
