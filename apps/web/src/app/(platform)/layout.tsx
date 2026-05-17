import Link from "next/link";
import { auth } from "@/lib/auth.config";
import BrandLogo from "@/components/BrandLogo";
import { BellIcon, ChevronDownIcon } from "@/components/JongoIcons";
import PlatformPrimaryNav from "@/components/navigation/PlatformPrimaryNav";
import SignOutButton from "@/components/auth/SignOutButton";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const email = session?.user?.email ?? "Account";
  const userLabel = email === "Account" ? email : email.split("@")[0];
  const userInitial = userLabel.slice(0, 1).toUpperCase();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <PlatformPrimaryNav />
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
                <SignOutButton />
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
