import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "jongo-os",
  description: "Open-source self-hosted operations UX for Coolify"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
