import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { isAdminRole } from "@/lib/roles";

type Params = { params: Promise<{ siteId: string }> };

async function getAppAdminState(siteId: string, userId: string) {
  const { db } = await import("@/lib/db");
  const site = await db.site.findFirst({
    where: {
      id: siteId,
      deletedAt: null,
      organization: {
        deletedAt: null,
        OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }]
      }
    },
    include: {
      organization: {
        select: {
          ownerId: true,
          collaborators: {
            where: { userId },
            select: { role: true }
          }
        }
      },
      collaborators: {
        where: { userId },
        select: { role: true }
      }
    }
  });

  if (!site) {
    return { isAdmin: false };
  }

  const orgAdmin = site.organization.ownerId === userId || isAdminRole(site.organization.collaborators[0]?.role);
  const siteAdmin = isAdminRole(site.collaborators[0]?.role);

  return { isAdmin: orgAdmin || siteAdmin };
}

export default async function AdvancedPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const workspace = await getSiteWorkspace(siteId);

  const { isAdmin } = session?.user?.id ? await getAppAdminState(siteId, session.user.id) : { isAdmin: false };

  if (!isAdmin) {
    return (
      <div className="page-stack">
        <article className="card">
          <h2 style={{ marginTop: 0 }}>Advanced</h2>
          <p className="card-muted">Infrastructure diagnostics are restricted to app admins.</p>
        </article>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Advanced</h2>
        <p className="card-muted">Infrastructure details and diagnostics for app admins.</p>
      </article>

      <article className="card">
        <h3 className="card-title">Developer Details</h3>
        <div style={{ display: "grid", gap: "0.35rem" }}>
          <p style={{ margin: 0 }}>Source: {workspace?.source ?? "unknown"}</p>
          <p style={{ margin: 0 }}>Ownership: {workspace?.ownershipState ?? "unavailable"}</p>
          {workspace?.coolifyServiceUuid ? <p style={{ margin: 0 }}>Coolify UUID: {workspace.coolifyServiceUuid}</p> : null}
          {workspace?.coolifyProjectId ? <p style={{ margin: 0 }}>Coolify Project ID: {workspace.coolifyProjectId}</p> : null}
          {workspace?.coolifyEnvironmentName ? <p style={{ margin: 0 }}>Coolify Environment: {workspace.coolifyEnvironmentName}</p> : null}
          {workspace?.gitRepositoryUrl ? <p style={{ margin: 0 }}>Repository: {workspace.gitRepositoryUrl}</p> : null}
        </div>
      </article>
    </div>
  );
}
