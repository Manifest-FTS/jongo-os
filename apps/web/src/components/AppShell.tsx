import Link from "next/link";
import type { ReactNode } from "react";

const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/organizations", label: "Clients" },
  { href: "/sites", label: "Sites" },
  { href: "/settings", label: "Settings" }
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
        <p className="tag">jongo-os operational platform</p>
        <h1 style={{ margin: "0.65rem 0 0.2rem" }}>
          <span className="brand-text">Jongo</span> {title}
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
            style={{
              textDecoration: "none",
              color: "#1f3e28",
              fontWeight: 600,
              border: "1px solid #d7e4d1",
              borderRadius: "999px",
              padding: "0.32rem 0.72rem",
              background: "#f0f7eb"
            }}
          >
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
          <strong>jongo-os</strong> is open-source and self-hosted. Support the project:
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
