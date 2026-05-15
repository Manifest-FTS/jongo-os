import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand card">
          <p className="tag" style={{ marginBottom: "0.65rem" }}>
            powered by Manifest FTS
          </p>
          <p className="brand-lockup" style={{ margin: "0 0 0.4rem" }}>
            <BrandLogo
              src="/assets/images/jongo-logo-color.png"
              alt="Jongo"
              width={124}
              height={36}
              fallbackText="Jongo"
            />
          </p>
          <h1 style={{ margin: 0 }}>Operations</h1>
          <p className="card-muted" style={{ marginTop: "0.35rem" }}>
            Managed client and site operations workspace.
          </p>
        </div>

        <nav className="app-nav card">
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/organizations">Clients</Link>
          <Link href="/sites">Sites</Link>
          <Link href="/settings">Settings</Link>
        </nav>

        <div className="app-sidebar-panel card">
          <p className="card-muted" style={{ marginBottom: "0.5rem" }}>
            Next Steps
          </p>
          <p style={{ margin: 0, fontSize: "0.92rem", lineHeight: 1.5 }}>
            Create a client, add a site, then use publishing and team tools.
          </p>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar card">
          <p className="tag" style={{ margin: 0 }}>
            Managed operations portal
          </p>
        </header>

        <div className="app-content">{children}</div>

        <footer className="app-footer">
          <p style={{ margin: "0 0 0.5rem" }}>
            <strong>Jongo</strong> is open-source and self-hosted.
          </p>
          <p style={{ margin: 0 }}>
            <a href="https://github.com/sponsors/manifest-fts">GitHub Sponsors</a> |{" "}
            <a href="https://opencollective.com/jongo-os">OpenCollective</a> |{" "}
            <a href="https://github.com/manifest-fts/jongo-os">GitHub Repository</a>
          </p>
        </footer>
      </div>
    </div>
  );
}
