import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, isClientAdmin } from "@/lib/repositories";
import { isPlatformAdminUser } from "@/lib/rbac";
import { activityDetail, activityLabel } from "@/lib/activity-labels";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams?: Promise<{ before?: string }>;
};

const PAGE_SIZE = 50;

/**
 * Who did what on this client: deploys, staging, domains, team changes.
 * Admins of the client (and platform admins) only, like Settings.
 */
export default async function ClientActivityPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const session = await auth();
  if (!session?.user?.id) notFound();

  const client = await getClientWorkspace(clientId, { userId: session.user.id, email: session.user.email });
  if (!client?.dbId) notFound();
  const allowed = (await isClientAdmin(client.dbId, session.user.id)) || (await isPlatformAdminUser(session.user.id));
  if (!allowed) notFound();

  const beforeRaw = (await searchParams)?.before;
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;

  const { getDb } = await import("@/lib/db");
  const db: any = await getDb();
  const rows: Array<{
    id: string;
    action: string;
    resourceType: string | null;
    resourceId: string | null;
    details: unknown;
    createdAt: Date;
    actor: { email: string; fullName: string | null } | null;
  }> = db
    ? await db.auditLog.findMany({
        where: { organizationId: client.dbId, ...(before ? { createdAt: { lt: before } } : {}) },
        orderBy: { createdAt: "desc" },
        take: PAGE_SIZE + 1,
        select: {
          id: true,
          action: true,
          resourceType: true,
          resourceId: true,
          details: true,
          createdAt: true,
          actor: { select: { email: true, fullName: true } }
        }
      })
    : [];

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  // App names for rows about an app, in one query.
  const siteIds = [...new Set(page.filter((r) => r.resourceType === "site" && r.resourceId).map((r) => r.resourceId as string))];
  const uuidLike = siteIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const sites: Array<{ id: string; name: string }> =
    db && uuidLike.length
      ? await db.site.findMany({ where: { id: { in: uuidLike }, organizationId: client.dbId }, select: { id: true, name: true } })
      : [];
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <article className="card">
        <h2 className="card-title" style={{ marginBottom: "0.25rem" }}>Activity</h2>
        <p className="card-muted" style={{ margin: 0 }}>
          Changes made to {client.name}&apos;s apps and team, newest first. Times are in UTC.
        </p>
      </article>

      <article className="card" style={{ padding: 0, overflow: "hidden" }}>
        {page.length === 0 ? (
          <p className="card-muted" style={{ padding: "1.25rem", margin: 0 }}>
            {before ? "No earlier activity." : "Nothing has happened here yet."}
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {page.map((row) => {
              const detail = activityDetail(row.details);
              const app = row.resourceType === "site" && row.resourceId ? siteName.get(row.resourceId) : null;
              const who = row.actor ? row.actor.fullName?.trim() || row.actor.email : "Jongo";
              return (
                <li
                  key={row.id}
                  style={{ display: "flex", gap: "1rem", justifyContent: "space-between", padding: "0.8rem 1.25rem", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: "0.93rem" }}>
                      {activityLabel(row.action, row.details)}
                      {app ? <span className="card-muted" style={{ fontWeight: 400 }}> · {app}</span> : null}
                    </p>
                    <p className="card-muted" style={{ margin: "0.15rem 0 0", fontSize: "0.85rem" }}>
                      {who}
                      {detail ? ` · ${detail}` : ""}
                    </p>
                  </div>
                  <time className="card-muted" dateTime={new Date(row.createdAt).toISOString()} style={{ fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                    {formatter.format(new Date(row.createdAt))}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </article>

      {hasMore ? (
        <div>
          <Link
            className="btn btn-secondary"
            href={`/clients/${clientId}/activity?before=${encodeURIComponent(new Date(page[page.length - 1].createdAt).toISOString())}`}
          >
            Older activity
          </Link>
        </div>
      ) : null}
    </div>
  );
}
