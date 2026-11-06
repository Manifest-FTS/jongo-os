import type { Metadata } from "next";

// Like the auth pages: useful to the person signing in, never to a search index. Not "no-referrer": under that
// policy browsers send `Origin: null` on form POSTs, so the consent route's Origin check always failed. "same-origin"
// keeps Origin intact for our own POST and still sends nothing to other sites; the redirect back to the site also
// carries its own no-referrer header, so the authorization code never leaks through a referrer.
export const metadata: Metadata = {
  title: "Sign in with Jongo",
  robots: { index: false, follow: false },
  referrer: "same-origin"
};

export default function OidcLayout({ children }: { children: React.ReactNode }) {
  return <main className="auth-layout">{children}</main>;
}
