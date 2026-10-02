/**
 * The homepage: the public hosting page, for everyone.
 *
 * Signed-in visitors used to be redirected straight to /dashboard; they now
 * see the site like anyone else, with a Dashboard button in the header
 * (components/PublicSiteHeader.tsx). Sign-in still lands on /dashboard.
 *
 * /hosting, the page's old address, redirects here (next.config.js).
 */
export { default, metadata } from "./hosting/page";

// Segment config must be written here, not re-exported. Same hourly refresh as
// the hosting page: the domain prices on it change rarely.
export const revalidate = 3600;
