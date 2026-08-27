import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { isPlatformAdminEmail } from "@/lib/permissions";
import NotificationsListView from "@/components/NotificationsListView";
import ComposeBroadcastForm from "@/components/ComposeBroadcastForm";
import BroadcastHistoryView from "@/components/BroadcastHistoryView";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function tabClassName(active: boolean) {
  return `tab-link${active ? " is-active" : ""}`;
}

export default async function NotificationsPage({ searchParams }: PageProps) {
  const session = await auth();
  const isAdmin = await isPlatformAdminEmail(session?.user?.email);
  const params = (await searchParams) ?? {};
  const rawTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const activeTab = rawTab === "compose" ? "compose" : "history";

  return (
    <div>
      <div className="card page-hero" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Notifications</p>
        <h1 style={{ margin: 0 }}>{isAdmin ? "Notifications & Broadcasts" : "Notifications"}</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          {isAdmin
            ? "Review notification activity and message clients directly."
            : "Updates about your apps, backups, and messages from the Jongo team."}
        </p>
      </div>

      {isAdmin ? (
        <>
          <div className="tab-rail" role="tablist" aria-label="Notification sections" style={{ marginBottom: "1rem" }}>
            <Link href="/notifications" className={tabClassName(activeTab === "history")} aria-current={activeTab === "history" ? "page" : undefined}>
              Activity History
            </Link>
            <Link href="/notifications?tab=compose" className={tabClassName(activeTab === "compose")} aria-current={activeTab === "compose" ? "page" : undefined}>
              Compose Broadcast
            </Link>
          </div>

          {activeTab === "compose" ? <ComposeBroadcastForm /> : <BroadcastHistoryView />}
        </>
      ) : (
        <NotificationsListView />
      )}
    </div>
  );
}
