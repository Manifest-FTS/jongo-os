import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { getRuntimeConfigStatus } from "@/lib/runtime-config";
import { canAccessRuntimeDiagnostics, runRuntimeDiagnosticsProbe } from "@/lib/runtime-diagnostics";
import { getGravatarUrl } from "@/lib/gravatar";
import { splitFullName } from "@/lib/profile";
import { GlobeIcon, LockIcon, UserIcon } from "@/components/JongoIcons";
import EmailTestPanel from "@/components/EmailTestPanel";
import OwnershipSyncPanel from "@/components/OwnershipSyncPanel";
import PendingBadge from "@/components/PendingBadge";
import ProfileSettingsForm from "@/components/ProfileSettingsForm";

type SettingsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type SettingsTab = "profile" | "platform" | "security";

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function resolveSettingsTab(value?: string | string[]): SettingsTab {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "platform" || raw === "security") {
    return raw;
  }

  return "profile";
}

function safeHostname(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function tabClassName(active: boolean) {
  return `tab-link${active ? " is-active" : ""}`;
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const session = await auth();
  if (!session?.user?.id) {
    notFound();
  }

  const runtime = getRuntimeConfigStatus();
  const sessionEmail = normalizeEmail(session.user.email);
  const bootstrapAdminEmail = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const isPlatformAdmin = Boolean(bootstrapAdminEmail && sessionEmail === bootstrapAdminEmail);
  const canViewDiagnostics = isPlatformAdmin && canAccessRuntimeDiagnostics({ sessionEmail: session.user.email });
  const requestedTab = resolveSettingsTab((await searchParams)?.tab);
  const activeTab = requestedTab === "platform" && !isPlatformAdmin ? "profile" : requestedTab;

  const prisma = await getDb();
  const currentUser = prisma
    ? await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { email: true, fullName: true, avatarUrl: true, authProvider: true }
      })
    : null;

  const currentEmail = currentUser?.email ?? session.user.email;
  const currentFullName = currentUser?.fullName ?? session.user.name ?? null;
  const profileImageUrl = currentUser?.avatarUrl ?? getGravatarUrl(currentEmail, 160);
  const { firstName, lastName } = splitFullName(currentFullName);

  let username = "";
  let profileRole = "";
  if (prisma) {
    try {
      const rows = await prisma.$queryRaw<Array<{ username: string | null; profileRole: string | null }>>`
        SELECT "username", "profileRole"
        FROM "UserProfileSettings"
        WHERE "userId" = ${session.user.id}::uuid
          AND "deletedAt" IS NULL
        LIMIT 1
      `;

      username = rows[0]?.username ?? "";
      profileRole = rows[0]?.profileRole ?? "";
    } catch {
      username = "";
      profileRole = "";
    }
  }

  const requestHeaders = await headers();
  const hostHeader = requestHeaders.get("host")?.split(":")[0] ?? null;
  const sftpHost = safeHostname(process.env.NEXTAUTH_URL) ?? hostHeader ?? "Configured during provisioning";

  const diagnostics = activeTab === "platform" && canViewDiagnostics ? await runRuntimeDiagnosticsProbe() : null;
  const recentRepoCall = diagnostics?.repositoryCalls[diagnostics.repositoryCalls.length - 1];
  const recentInventory = diagnostics?.coolifyInventoryHistory[diagnostics.coolifyInventoryHistory.length - 1];
  const recentEndpointCalls = diagnostics?.coolifyEndpointCalls.slice(-8).reverse() ?? [];
  const recentEndpointFailureCount = recentEndpointCalls.filter((call) => !call.success).length;
  const latestEndpointCall = recentEndpointCalls[0];
  const directoryCacheLookupTotal = diagnostics
    ? diagnostics.directoryBackupPostureCache.hits +
      diagnostics.directoryBackupPostureCache.misses +
      diagnostics.directoryBackupPostureCache.inFlightJoins
    : 0;
  const directoryCacheHitRate =
    directoryCacheLookupTotal > 0
      ? ((diagnostics!.directoryBackupPostureCache.hits + diagnostics!.directoryBackupPostureCache.inFlightJoins) /
          directoryCacheLookupTotal) *
        100
      : 0;
  const directoryCacheMissRate =
    directoryCacheLookupTotal > 0
      ? (diagnostics!.directoryBackupPostureCache.misses / directoryCacheLookupTotal) * 100
      : 0;
  const directoryCacheStatusLabel = diagnostics
    ? diagnostics.directoryBackupPostureCache.errors > 0
      ? "attention"
      : directoryCacheMissRate >= 50
        ? "watch"
        : "healthy"
    : "unknown";

  return (
    <div>
      <div className="card page-hero" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Settings</p>
        <h1 style={{ margin: 0 }}>Profile Settings</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Manage your account profile, security, and platform preferences.
        </p>
      </div>

      <div className="tab-rail" role="tablist" aria-label="Settings sections" style={{ marginBottom: "1rem" }}>
        <Link href="/settings" className={tabClassName(activeTab === "profile")} aria-current={activeTab === "profile" ? "page" : undefined}>
          Profile
        </Link>
        {isPlatformAdmin ? (
          <Link href="/settings?tab=platform" className={tabClassName(activeTab === "platform")} aria-current={activeTab === "platform" ? "page" : undefined}>
            Platform
          </Link>
        ) : null}
        <Link href="/settings?tab=security" className={tabClassName(activeTab === "security")} aria-current={activeTab === "security" ? "page" : undefined}>
          Security
        </Link>
      </div>

      {activeTab === "profile" ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(280px, 1fr)", gap: "1rem" }}>
          <article className="card">
            <h3 className="card-title">Update your profile</h3>
            <ProfileSettingsForm
              initial={{
                email: currentEmail,
                firstName,
                lastName,
                username,
                profileRole,
                imageUrl: profileImageUrl
              }}
            />
          </article>

          <article className="card">
            <h3 className="card-title">SFTP Access</h3>
            <div style={{ display: "grid", gap: "0.85rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
                <GlobeIcon style={{ width: "1rem", height: "1rem", color: "var(--muted)" }} />
                <div>
                  <p className="card-muted" style={{ margin: 0, fontSize: "0.8rem" }}>Host</p>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: "0.92rem" }}>{sftpHost}, Port 22</p>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
                <UserIcon style={{ width: "1rem", height: "1rem", color: "var(--muted)" }} />
                <div>
                  <p className="card-muted" style={{ margin: 0, fontSize: "0.8rem" }}>User</p>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: "0.92rem" }}>{username || "Save a username in your profile"}</p>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
                <LockIcon style={{ width: "1rem", height: "1rem", color: "var(--muted)" }} />
                <div>
                  <p className="card-muted" style={{ margin: 0, fontSize: "0.8rem" }}>Password</p>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: "0.92rem" }}>Your Jongo password</p>
                </div>
              </div>
            </div>
          </article>
        </div>
      ) : null}

      {activeTab === "security" ? (
        <div className="grid">
          <article className="card tone-card">
            <h3 className="card-title">Security</h3>
            <p className="card-muted">
              Password changes, two-factor authentication, and recovery settings will live here.
            </p>
            <ul style={{ fontSize: "0.9rem", margin: "0.75rem 0 0", paddingLeft: "1.25rem" }}>
              <li>Authentication provider: {currentUser?.authProvider ?? "local credentials"}</li>
              <li>Password updates and recovery options are being prepared.</li>
              <li>Two-factor authentication will be added in a follow-up pass.</li>
            </ul>
          </article>

          <article className="card tone-card">
            <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
              Access Tokens <PendingBadge reason="Personal API token management is not yet available. Tokens for scripting and integrations will be generated here." />
            </h3>
            <p className="card-muted">Manage personal automation access and revoke unused tokens.</p>
          </article>
        </div>
      ) : null}

      {isPlatformAdmin && activeTab === "platform" ? (
        isPlatformAdmin ? (
          <>
            <div className="grid" style={{ marginBottom: "2rem" }}>
              <OwnershipSyncPanel />

              <article className="card tone-card">
                <h3 className="card-title">Publishing Integration</h3>
                <p className="card-muted">Connection status for deployment provider.</p>
                <div style={{ marginTop: "1rem", display: "grid", gap: "0.6rem" }}>
                  <p style={{ margin: 0, fontSize: "0.9rem" }}>
                    Runtime mode: {runtime.coolifyMode}
                  </p>
                  <p style={{ margin: 0, fontSize: "0.9rem" }}>
                    Base URL: {runtime.coolifyBaseUrlConfigured ? "configured" : "missing"}
                  </p>
                  <p style={{ margin: 0, fontSize: "0.9rem" }}>
                    API token: {runtime.coolifyTokenConfigured ? "configured" : "missing"}
                  </p>
                </div>
              </article>

              <article className="card tone-card">
                <h3 className="card-title">Email Delivery</h3>
                <p className="card-muted">Invite and transactional email configuration status.</p>
                <div style={{ marginTop: "0.8rem", display: "grid", gap: "0.55rem" }}>
                  <p style={{ margin: 0, fontSize: "0.9rem" }}>
                    Provider mode: {runtime.emailProviderMode === "disabled"
                      ? "Disabled"
                      : runtime.emailProviderMode === "smtp2go_api"
                      ? "SMTP2GO API"
                      : "Generic SMTP"}
                  </p>
                  <p style={{ margin: 0, fontSize: "0.9rem" }}>
                    Status: {runtime.emailConfigured ? "configured" : "not configured"}
                  </p>
                </div>

                {canViewDiagnostics ? (
                  <EmailTestPanel />
                ) : (
                  <p className="card-muted" style={{ marginTop: "0.8rem" }}>
                    Test email action is available to admin/dev diagnostics users.
                  </p>
                )}
              </article>
            </div>

            <div className="grid">
              <article className="card tone-card">
                <h3 className="card-title">Developer Details</h3>
                <details>
                  <summary style={{ cursor: "pointer", fontSize: "0.9rem", color: "var(--muted)" }}>
                    View server runtime checks
                  </summary>
                  <ul style={{ fontSize: "0.86rem", margin: "0.65rem 0 0", paddingLeft: "1.25rem" }}>
                    <li>DATABASE_URL: {runtime.databaseConfigured ? "configured" : "missing"}</li>
                    <li>NEXTAUTH_SECRET: {runtime.nextauthSecretConfigured ? "configured" : "missing"}</li>
                    <li>Provider integration secrets stay server-only</li>
                  </ul>
                </details>

                {canViewDiagnostics && diagnostics ? (
                  <details id="runtime-diagnostics" style={{ marginTop: "0.8rem" }}>
                    <summary style={{ cursor: "pointer", fontSize: "0.9rem", color: "var(--muted)" }}>
                      Runtime diagnostics (admin/dev)
                    </summary>

                    <div style={{ marginTop: "0.65rem", display: "grid", gap: "0.5rem", fontSize: "0.85rem" }}>
                      <p style={{ margin: 0 }}>
                        Last successful Coolify inventory fetch: {diagnostics.lastSuccessfulCoolifyInventoryFetchAt ?? "never"}
                      </p>
                      <p style={{ margin: 0 }}>
                        Last non-empty Coolify inventory fetch: {diagnostics.lastNonEmptyCoolifyInventoryFetchAt ?? "never"}
                      </p>
                      <p style={{ margin: 0 }}>
                        Latest inventory source: {recentInventory ? `${recentInventory.source} (${recentInventory.mode})` : "n/a"}
                      </p>
                      <p style={{ margin: 0 }}>
                        Latest repo source decision: {recentRepoCall ? `${recentRepoCall.operation} -> ${recentRepoCall.source}` : "n/a"}
                      </p>
                      <p style={{ margin: 0 }}>
                        Directory backup cache health: {directoryCacheStatusLabel}
                      </p>
                      <p style={{ margin: 0 }}>
                        Directory backup cache summary: lookups={directoryCacheLookupTotal}, hit-rate={directoryCacheHitRate.toFixed(1)}%, errors={diagnostics.directoryBackupPostureCache.errors}, last-event={diagnostics.directoryBackupPostureCache.lastEventAt ?? "never"}
                      </p>
                      <p style={{ margin: 0 }}>
                        Recent endpoint health: failures in last 8 calls={recentEndpointFailureCount}, latest={latestEndpointCall ? `${latestEndpointCall.path} (${latestEndpointCall.statusCode ?? "n/a"})` : "n/a"}
                      </p>
                      <p style={{ margin: 0 }}>
                        Env presence: DATABASE_URL={diagnostics.envPresence.databaseUrl ? "yes" : "no"}, COOLIFY_API_BASE_URL={diagnostics.envPresence.coolifyApiBaseUrl ? "yes" : "no"}, COOLIFY_API_TOKEN={diagnostics.envPresence.coolifyApiToken ? "yes" : "no"}, NEXTAUTH_SECRET={diagnostics.envPresence.nextauthSecret ? "yes" : "no"}
                      </p>
                    </div>
                  </details>
                ) : null}
              </article>
            </div>
          </>
        ) : null
      ) : null}
    </div>
  );
}
