import { NOINDEX } from "@/lib/seo";

// Internal design reference, behind sign-in: never indexed.
export const metadata = NOINDEX;

export default function StyleGuideLayout({ children }: { children: React.ReactNode }) {
  return children;
}
