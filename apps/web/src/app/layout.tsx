import type { Metadata } from "next";
import "./globals.css";
import AppToaster from "@/components/AppToaster";
import SessionProviderWrapper from "@/components/SessionProviderWrapper";

export const metadata: Metadata = {
  title: "Jongo",
  description: "Self-hosted operations UX for Coolify",
  icons: {
    icon: "/favicon.ico"
  }
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

