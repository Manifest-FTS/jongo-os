import { NOINDEX } from "@/lib/seo";

// Sign-in, sign-up and password pages: useful to people, not to search results.
export const metadata = NOINDEX;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main className="auth-layout">{children}</main>;
}
