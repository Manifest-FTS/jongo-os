import type { Metadata } from "next";

// Like the auth pages: useful to the person signing in, never to a search index. The referrer is
// withheld so the authorization parameters on this URL are not leaked to the destination site.
export const metadata: Metadata = {
  title: "Sign in with Jongo",
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

export default function OidcLayout({ children }: { children: React.ReactNode }) {
  return <main className="auth-layout">{children}</main>;
}
