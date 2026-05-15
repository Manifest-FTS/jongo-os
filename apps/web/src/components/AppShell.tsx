import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { BuildingOfficeIcon, DashboardIcon, ServerIcon, SettingsIcon } from "@/components/JongoIcons";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/organizations", label: "Clients", icon: BuildingOfficeIcon },
  { href: "/sites", label: "Sites", icon: ServerIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon }
];

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main>
      <header
        className="card"
        style={{
          marginBottom: "1rem",
          background:
            "radial-gradient(circle at 0% 0%, rgba(212, 175, 55, 0.16), transparent 30%), radial-gradient(circle at 100% 0%, rgba(255, 47, 176, 0.11), transparent 30%), linear-gradient(180deg, #ffffff 0%, #f8faf9 100%)"
        }}
      >
        <p className="tag">powered by Manifest FTS</p>
        <p className="brand-lockup" style={{ margin: "0.6rem 0 0.1rem" }}>
          <Image
            src="/assets/images/jongo-logomark-color.png"
            alt="Jongo"
            width={32}
            height={32}
            className="brand-mark"
          />
          <span className="brand-text" style={{ fontWeight: 700 }}>Jongo</span>
        </p>
        <h1 style={{ margin: "0.65rem 0 0.2rem" }}>
          {title}
        </h1>
        <p style={{ marginTop: 0, color: "var(--muted)", maxWidth: "68ch" }}>
          Self-hosted operational UX for Coolify-managed environments.
        </p>
      </header>

      <nav
        className="card"
        style={{ marginBottom: "1rem", display: "flex", gap: "0.55rem", flexWrap: "wrap", background: "var(--surface-alt)" }}
      >
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="nav-pill"
          >
            <item.icon />
            {item.label}
          </Link>
        ))}
      </nav>

      {children}

      {/* Footer with Sponsorship Links */}
      <footer
        style={{
          marginTop: "3rem",
          paddingTop: "2rem",
          borderTop: "1px solid var(--border)",
          textAlign: "center",
          color: "var(--muted)",
          fontSize: "0.85rem"
        }}
      >
        <p style={{ margin: "0 0 0.5rem" }}>
          <strong>Jongo</strong> is open-source and self-hosted. Support the project:
        </p>
        <p style={{ margin: 0 }}>
          <a href="https://github.com/sponsors/manifest-fts" style={{ color: "var(--accent)", textDecoration: "none" }}>
            GitHub Sponsors
          </a>{" "}
          •{" "}
          <a href="https://opencollective.com/jongo-os" style={{ color: "var(--accent)", textDecoration: "none" }}>
            OpenCollective
          </a>{" "}
          •{" "}
          <a href="https://github.com/manifest-fts/jongo-os" style={{ color: "var(--accent)", textDecoration: "none" }}>
            GitHub Repository
          </a>
        </p>
      </footer>
    </main>
  );
}
