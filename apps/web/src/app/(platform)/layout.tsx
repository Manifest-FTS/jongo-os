import Link from "next/link";
import type { Viewport } from "next";
import localFont from "next/font/local";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { getGravatarUrl } from "@/lib/gravatar";
import { getInitials } from "@/lib/profile";
import JongoBrandLockup from "@/components/brand/JongoBrandLockup";
import { ChevronDownIcon } from "@/components/JongoIcons";
import DesktopNotificationPrompt from "@/components/DesktopNotificationPrompt";
import NotificationBell from "@/components/NotificationBell";
import PlatformPrimaryNav from "@/components/navigation/PlatformPrimaryNav";
import SignOutButton from "@/components/auth/SignOutButton";
import UserAvatar from "@/components/UserAvatar";
import WorkspaceSwitcher from "@/components/navigation/WorkspaceSwitcher";
import PlatformBrandFooter from "@/components/brand/PlatformBrandFooter";
import { listWorkspaceOptions, type WorkspacePage } from "@/lib/workspace-switcher";
import { NOINDEX } from "@/lib/seo";
import { isSuperAdminUser } from "@/lib/rbac";
import "@/styles/brand-platform.css";

// Self-hosted (variable files, latin) so the build never depends on Google Fonts being reachable.
const platformHeadings = localFont({
  src: "../../fonts/dm-sans-latin.woff2", weight: "100 1000", display: "swap", variable: "--font-platform-heading"
});
const platformBody = localFont({
  src: "../../fonts/inter-latin.woff2", weight: "100 900", display: "swap", variable: "--font-platform-body"
});
const platformStats = localFont({
  src: "../../fonts/josefin-sans-latin.woff2", weight: "100 700", display: "swap", variable: "--font-platform-stat"
});

// The signed-in app: never indexed (it is behind sign-in anyway).
export const metadata = NOINDEX;

// Light workspace with dark navigation chrome, confined to the signed-in app.
export const viewport: Viewport = { colorScheme: "light", themeColor: "#fafafa" };

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  // The browser still holds a session cookie (middleware let it through) but
  // the account signed out everywhere, reset its password, or was removed.
  if (!session?.user?.id) redirect("/auth/login?ended=1");
  const canViewBilling = await isSuperAdminUser(session?.user?.id);
  const sessionEmail = session?.user?.email ?? "Account";
  let workspaces: WorkspacePage = { items: [], hasMore: false, nextCursor: null };
  if (session?.user?.id) {
    try { workspaces = await listWorkspaceOptions(session.user.id); }
    catch { /* Retry in the switcher; never substitute demo teams. */ }
  }

  let email = sessionEmail;
  let fullName = session?.user?.name ?? null;
  let imageUrl: string | null = null;

  if (session?.user?.id) {
    const prisma = await getDb();
    if (prisma) {
      const currentUser = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { email: true, fullName: true, avatarUrl: true }
      });

      if (currentUser) {
        email = currentUser.email;
        fullName = currentUser.fullName ?? null;
        imageUrl = currentUser.avatarUrl ?? getGravatarUrl(currentUser.email, 96);
      }
    }
  }

  const userLabel = fullName?.trim() || (email === "Account" ? email : email.split("@")[0]);
  const userInitials = getInitials(fullName, email);

  return (
    <div data-platform-theme="light" className={`app-shell ${platformHeadings.variable} ${platformBody.variable} ${platformStats.variable}`}>
      <aside className="app-sidebar">
        <div className="sidebar-workspace-switcher">
          <span className="sidebar-section-label">WORKSPACE</span>
          <WorkspaceSwitcher initialOptions={workspaces.items} hasMore={workspaces.hasMore} nextCursor={workspaces.nextCursor} />
        </div>
        <PlatformPrimaryNav canViewBilling={canViewBilling} />
      </aside>

      <div className="app-main">
        <header className="app-topbar card">
          <Link href="/dashboard" className="topbar-logo" aria-label="Jongo dashboard home">
            <JongoBrandLockup />
          </Link>

          <div className="topbar-actions">
            <NotificationBell />
            <details className="user-menu">
              <summary className="user-menu-trigger">
                <UserAvatar imageUrl={imageUrl} initials={userInitials} alt={userLabel} size={26} />
                <span className="user-label">{userLabel}</span>
                <ChevronDownIcon className="topbar-icon" />
              </summary>
              <div className="user-menu-panel">
                <p className="user-menu-email">{email}</p>
                <Link href="/settings" className="user-menu-link-button">Profile Settings</Link>
                <SignOutButton />
              </div>
            </details>
          </div>
        </header>

        <div className="app-content">{children}</div>

        <PlatformBrandFooter />
      </div>

      <DesktopNotificationPrompt />
    </div>
  );
}
