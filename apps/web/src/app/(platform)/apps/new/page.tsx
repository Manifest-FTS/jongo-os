import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import CreateSiteForm from "@/components/CreateSiteForm";
import { isClientAdmin } from "@/lib/repositories";
import { isPlatformAdminUser } from "@/lib/rbac";

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

/**
 * New app, like Vercel's "Add New → Project": choose the workspace (client),
 * then the source (GitHub, GitLab/Bitbucket/any Git, a public repository or
 * WordPress), check the detected framework and deploy.
 */
export default async function NewAppPage({ searchParams }: Props) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/auth/login?callbackUrl=/apps/new");

  const query = (await searchParams) ?? {};
  const chosen = typeof query.client === "string" ? query.client : "";

  const { db } = await import("@/lib/db");
  const platformAdmin = await isPlatformAdminUser(userId);
  const workspaces: Array<{ id: string; name: string }> = await db.organization.findMany({
    where: {
      deletedAt: null,
      ...(platformAdmin ? {} : { OR: [{ ownerId: userId }, { collaborators: { some: { userId, deletedAt: null } } }] })
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
    take: 500
  });

  const workspace = workspaces.find((candidate) => candidate.id === chosen) ?? (workspaces.length === 1 ? workspaces[0] : null);
  const canManage = workspace ? platformAdmin || (await isClientAdmin(workspace.id, userId)) : false;

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">New app</h1>
          <p className="page-subtitle">Import a Git repository or create a WordPress site. Hosting, the address and the first deploy are set up for you.</p>
        </div>
      </div>

      {workspaces.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>Create a client first, then add apps to it.</p>
          <p style={{ margin: "0.75rem 0 0" }}>
            <Link href="/clients" className="action-link">Open clients</Link>
          </p>
        </div>
      ) : (
        <div className="card">
          <form method="get" className="form-row" style={{ alignItems: "end", flexWrap: "wrap" }}>
            <div style={{ minWidth: "16rem" }}>
              <label className="form-label" htmlFor="new-app-client">Client</label>
              <select id="new-app-client" name="client" className="form-input" defaultValue={workspace?.id ?? ""}>
                {!workspace ? <option value="">— Choose a client —</option> : null}
                {workspaces.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-secondary">{workspace ? "Switch" : "Continue"}</button>
          </form>
        </div>
      )}

      {workspace ? (
        <CreateSiteForm
          key={workspace.id}
          organizationId={workspace.id}
          githubOnly={!canManage}
          githubAvailable
          canAdopt={false}
          initiallyOpen
        />
      ) : null}
    </div>
  );
}
