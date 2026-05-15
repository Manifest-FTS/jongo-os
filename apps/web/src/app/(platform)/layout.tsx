import Link from "next/link";
import { auth } from "@/lib/auth.config";
import BrandLogo from "@/components/BrandLogo";
import { BellIcon, BuildingOfficeIcon, ChevronDownIcon, DashboardIcon, ServerIcon, SettingsIcon } from "@/components/JongoIcons";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const email = session?.user?.email ?? "Account";
  const userLabel = email === "Account" ? email : email.split("@")[0];
  const userInitial = userLabel.slice(0, 1).toUpperCase();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <nav className="app-nav card">
          <Link href="/dashboard">
            <span className="app-nav-label">
              <DashboardIcon className="sidebar-icon" />
              Dashboard
            </span>
          </Link>
          <Link href="/organizations">
            <span className="app-nav-label">
              <BuildingOfficeIcon className="sidebar-icon" />
              Clients
            </span>
          </Link>
          <Link href="/sites">
            <span className="app-nav-label">
              <ServerIcon className="sidebar-icon" />
              Sites
            </span>
          </Link>
          <Link href="/settings">
            <span className="app-nav-label">
              <SettingsIcon className="sidebar-icon" />
              Settings
            </span>
          </Link>
        </nav>
      </aside>

      <div className="app-main">
        <header className="app-topbar card">
          <Link href="/dashboard" className="topbar-logo" aria-label="Jongo dashboard home">
            <BrandLogo
              src="/assets/images/jongo-logo-color.png"
              alt="Jongo"
              width={126}
              height={38}
              fallbackText="Jongo"
            />
          </Link>

          <div className="topbar-actions">
            <button type="button" className="topbar-icon-button" aria-label="Notifications">
              <BellIcon className="topbar-icon" />
            </button>
            <details className="user-menu">
              <summary className="user-menu-trigger">
                <span className="user-avatar">{userInitial}</span>
                <span className="user-label">{userLabel}</span>
                <ChevronDownIcon className="topbar-icon" />
              </summary>
              <div className="user-menu-panel">
                <p className="user-menu-email">{email}</p>
                <Link href="/settings">Account settings</Link>
              </div>
            </details>
          </div>
        </header>

        <div className="app-content">{children}</div>

        <footer className="app-footer">
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
