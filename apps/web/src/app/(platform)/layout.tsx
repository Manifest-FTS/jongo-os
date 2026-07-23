import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { getGravatarUrl } from "@/lib/gravatar";
import { getInitials } from "@/lib/profile";
import BrandLogo from "@/components/BrandLogo";
import { BellIcon, ChevronDownIcon } from "@/components/JongoIcons";
import PlatformPrimaryNav from "@/components/navigation/PlatformPrimaryNav";
import SignOutButton from "@/components/auth/SignOutButton";
import UserAvatar from "@/components/UserAvatar";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const sessionEmail = session?.user?.email ?? "Account";

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
                <UserAvatar imageUrl={imageUrl} initials={userInitials} alt={userLabel} size={26} />
                <span className="user-label">{userLabel}</span>
                <ChevronDownIcon className="topbar-icon" />
              </summary>
              <div className="user-menu-panel">
                <p className="user-menu-email">{email}</p>
                <Link href="/settings">Profile Settings</Link>
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
