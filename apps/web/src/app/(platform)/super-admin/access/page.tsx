import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { AccessDirectoryError, getAccessDirectory } from "@/lib/access-directory";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  collaborator: "Collaborator"
};

type SearchParams = Record<string, string | string[] | undefined>;
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function requestedPage(value: string | undefined): number | undefined {
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}
function paramsHref(search: { q?: string; role?: string; page?: number; invitePage?: number }): string {
  const params = new URLSearchParams();
  if (search.q) params.set("q", search.q);
  if (search.role) params.set("role", search.role);
  if (search.page && search.page > 1) params.set("page", String(search.page));
  if (search.invitePage && search.invitePage > 1) params.set("invitePage", String(search.invitePage));
  const query = params.toString();
  return `/super-admin/access${query ? `?${query}` : ""}`;
}

function Pager({ page, hasMore, href }: { page: number; hasMore: boolean; href: (page: number) => string }) {
  return <div className="flex items-center gap-3 mt-4">
    <Link aria-disabled={page <= 1} className={`btn btn-secondary${page <= 1 ? " pointer-events-none opacity-50" : ""}`} href={href(Math.max(1, page - 1))}>Previous</Link>
    <span className="text-muted">Page {page}</span>
    <Link aria-disabled={!hasMore} className={`btn btn-secondary${!hasMore ? " pointer-events-none opacity-50" : ""}`} href={href(hasMore ? page + 1 : page)}>Next</Link>
  </div>;
}

export default async function SuperAdminAccessPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const session = await auth();
  const params = (await searchParams) ?? {};
  const q = (one(params.q) ?? "").trim().slice(0, 200);
  const rawRole = one(params.role);
  const role = rawRole === "super_admin" || rawRole === "admin" || rawRole === "collaborator" ? rawRole : "";
  const page = requestedPage(one(params.page)) ?? 1;
  const invitePage = requestedPage(one(params.invitePage)) ?? 1;

  let directory;
  try {
    directory = await getAccessDirectory(session?.user?.id, { q, role, page, invitePage });
  } catch (error) {
    if (error instanceof AccessDirectoryError && (error.status === 401 || error.status === 403)) notFound();
    return <article className="card"><h1 className="card-title">Access directory unavailable</h1><p className="card-muted">The directory could not be loaded. Try again shortly.</p></article>;
  }

  return <div className="page-stack">
    <div className="page-head"><div>
      <h1 className="page-title">Users &amp; access</h1>
      <p className="page-subtitle">Review global roles, platform-wide authority, client memberships, app grants and pending invitations.</p>
    </div></div>

    <section className="grid gap-4 sm:grid-cols-3" aria-label="Active global roles">
      {(["super_admin", "admin", "collaborator"] as const).map((key) => <article className="card" key={key}>
        <p className="metric-label m-0">{ROLE_LABEL[key]} accounts</p>
        <p className="mt-1 mb-0 text-[1.5rem] font-bold text-metric">{directory.counts[key]}</p>
      </article>)}
    </section>

    <article className="card">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div><h2 className="card-title m-0">Registered users</h2><p className="card-muted mt-1 mb-0">{directory.totalUsers} active accounts · client access includes all active apps in that client.</p></div>
      </div>
      <form method="get" className="form-row mt-4">
        <label className="form-label">Search by name or email
          <input className="form-input" type="search" name="q" maxLength={200} defaultValue={q} />
        </label>
        <label className="form-label">Global role
          <select className="form-input" name="role" defaultValue={role}>
            <option value="">All roles</option>
            <option value="super_admin">Super admin</option>
            <option value="admin">Admin</option>
            <option value="collaborator">Collaborator</option>
          </select>
        </label>
        <button className="btn btn-secondary self-end" type="submit">Filter</button>
      </form>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-[0.86rem] !table">
          <thead><tr className="text-left text-muted">
            <th scope="col" className="py-2 pr-3">User</th>
            <th scope="col" className="py-2 pr-3">Global role</th>
            <th scope="col" className="py-2 pr-3">Platform-wide access</th>
            <th scope="col" className="py-2 pr-3">Client access</th>
            <th scope="col" className="py-2 pr-3">Direct app access</th>
          </tr></thead>
          <tbody>
            {directory.users.map((user) => <tr key={user.id} className="border-0 border-t border-solid border-border align-top">
              <td className="py-3 pr-3"><strong>{user.fullName || user.email}</strong>{user.fullName ? <div className="text-muted">{user.email}</div> : null}</td>
              <td className="py-3 pr-3"><span className="status-chip">{ROLE_LABEL[user.role] ?? "Collaborator"}</span></td>
              <td className="py-3 pr-3">{user.platformAccess
                ? <><strong>{user.role === "super_admin" ? "Full platform access, including billing" : "Infrastructure and technical access"}</strong><div className="text-muted">{user.platformAccessSources.join(" · ")}</div></>
                : <span className="text-muted">No global access</span>}</td>
              <td className="py-3 pr-3">
                {[...user.ownedClients.map((client) => ({ ...client, access: "Owner" })), ...user.clientMemberships.map((client) => ({ ...client, access: ROLE_LABEL[client.role] ?? client.role }))].length
                  ? <ul className="m-0 list-none p-0 space-y-1">{[...user.ownedClients.map((client) => ({ ...client, access: "Owner" })), ...user.clientMemberships.map((client) => ({ ...client, access: ROLE_LABEL[client.role] ?? client.role }))].map((client) => <li key={`${user.id}-${client.id}-${client.access}`}>
                    <Link className="action-link" href={`/clients/${encodeURIComponent(client.id)}`}>{client.name}</Link>
                    <span className="text-muted"> · {client.access}; all {client.appCount} active app{client.appCount === 1 ? "" : "s"}</span>
                  </li>)}</ul>
                  : <span className="text-muted">No client assignments</span>}
              </td>
              <td className="py-3 pr-3">
                {user.appMemberships.length ? <ul className="m-0 list-none p-0 space-y-1">{user.appMemberships.map((app) => <li key={`${user.id}-${app.id}`}>
                  <Link className="action-link" href={`/apps/${encodeURIComponent(app.id)}`}>{app.name}</Link>
                  <span className="text-muted"> · {ROLE_LABEL[app.role] ?? app.role} · {app.clientName}</span>
                </li>)}</ul> : <span className="text-muted">No direct app grants</span>}
                {user.accessListsTruncated ? <p className="text-muted mt-1 mb-0">Showing first 20 scopes in a category.</p> : null}
              </td>
            </tr>)}
            {!directory.users.length ? <tr><td className="py-4 text-muted" colSpan={5}>No users match these filters.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <Pager page={directory.page} hasMore={directory.hasMoreUsers} href={(nextPage) => paramsHref({ q, role, page: nextPage, invitePage })} />
      <p className="card-muted mt-3 mb-0 text-[0.8rem]">This page is read-only. Platform admin grants and the bootstrap admin provide technical access, not billing access. Passwords, tokens, billing fields and invitation secrets are never loaded here.</p>
    </article>

    <article className="card">
      <div><h2 className="card-title m-0">Pending invitations</h2><p className="card-muted mt-1 mb-0">{directory.totalInvites} unexpired invitations that have not been accepted or revoked.</p></div>
      <div className="mt-3 overflow-x-auto"><table className="w-full text-[0.86rem] !table">
        <thead><tr className="text-left text-muted"><th scope="col" className="py-2 pr-3">Email</th><th scope="col" className="py-2 pr-3">Scope</th><th scope="col" className="py-2 pr-3">Scoped role</th><th scope="col" className="py-2 pr-3">Expires</th></tr></thead>
        <tbody>{directory.invites.map((invite) => <tr key={invite.id} className="border-0 border-t border-solid border-border">
          <td className="py-2 pr-3">{invite.email}</td>
          <td className="py-2 pr-3">{invite.inviteType === "site" && invite.site ? <><Link className="action-link" href={`/apps/${encodeURIComponent(invite.site.id)}`}>{invite.site.name}</Link><span className="text-muted"> · {invite.organization.name}</span></> : <Link className="action-link" href={`/clients/${encodeURIComponent(invite.organization.id)}`}>{invite.organization.name}</Link>}</td>
          <td className="py-2 pr-3">{ROLE_LABEL[invite.role] ?? invite.role}</td>
          <td className="py-2 pr-3 whitespace-nowrap">{new Date(invite.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
        </tr>)}
        {!directory.invites.length ? <tr><td className="py-4 text-muted" colSpan={4}>No pending invitations match this search.</td></tr> : null}</tbody>
      </table></div>
      <Pager page={directory.invitePage} hasMore={directory.hasMoreInvites} href={(nextPage) => paramsHref({ q, role, page, invitePage: nextPage })} />
    </article>
  </div>;
}
