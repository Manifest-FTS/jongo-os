import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppToaster from "@/components/AppToaster";
import SessionProviderWrapper from "@/components/SessionProviderWrapper";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/seo";

/**
 * Site-wide defaults. Each public page sets its own title, description and
 * canonical URL (lib/seo.ts pageMetadata); the app and sign-in pages opt out
 * of indexing in their layouts. The share image is app/opengraph-image.tsx.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME}: ${SITE_TAGLINE}`, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  category: "technology",
  keywords: [
    "managed WordPress hosting",
    "Next.js hosting",
    "Nuxt hosting",
    "Node.js hosting",
    "agency hosting",
    "domain registration",
    "domain transfer",
    "staging environments",
    "offsite backups",
    "website migration"
  ],
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US", url: "/" },
  twitter: { card: "summary_large_image" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 }
  },
  icons: { icon: "/favicon.ico", apple: "/assets/images/jongo-logomark-color.png" },
  alternates: { types: { "text/markdown": "/llms.txt" } }
};

/**
 * Jongo has one, light, palette. Without saying so, phone browsers in dark mode
 * (Chrome's auto-dark, Brave night mode, Samsung Internet) recolour the page on
 * their own, and inputs and muted text came out dark-on-dark. "only light"
 * opts out of that recolouring.
 */
export const viewport: Viewport = {
  colorScheme: "only light",
  themeColor: "#f4f5f5"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProviderWrapper>
          {children}
          <AppToaster />
        </SessionProviderWrapper>
      </body>
    </html>
  );
}
