import { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import WorkspaceTabs, { type WorkspaceTab } from "@/components/navigation/WorkspaceTabs";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, isClientAdmin } from "@/lib/repositories";
import { resolveClientLayoutAccess } from "@/lib/client-layout-access";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ clientId: string }>;
};

export default async function ClientWorkspaceLayout({ children, params }: LayoutProps) {
  const { clientId } = await params;
  const session = await auth();

  const access = await resolveClientLayoutAccess(clientId, session?.user?.id);
  if (!access) notFound();

  if (access.scope === "site") {
    // This is only a minimal shell, not organization or dataset authorization.
    // Overview/apps/sources/settings/content-preview each enforce their own
    // organization guard; team only redirects to the guarded overview. The
    // dataset page/actions independently require live membership + dataset grant
    // and bind the dataset to clientId. New children MUST enforce their own scope.
    // Never infer the child route from headers or fetch the broad workspace here.
    return (
      <div className="workspace-shell">
        <div className="workspace-hero card">
          <h1 className="workspace-title">{access.client.name}</h1>
          <p className="workspace-subtitle">Site-scoped content access</p>
        </div>
        <div className="workspace-content">{children}</div>
      </div>
    );
  }

  const client = await getClientWorkspace(clientId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }

  const canManageClient = Boolean(
    session?.user?.id &&
    client.dbId &&
    await isClientAdmin(client.dbId, session.user.id)
  );

  const tabs: WorkspaceTab[] = [
    { name: "Overview", href: `/clients/${clientId}`, match: "exact" },
    { name: "Apps", href: `/clients/${clientId}/apps` },
    // Git sources (GitHub Apps), like Coolify's Sources: the whole client team.
    { name: "Sources", href: `/clients/${clientId}/sources` },
    ...(canManageClient ? [{ name: "Settings", href: `/clients/${clientId}/settings` } satisfies WorkspaceTab] : [])
  ];

  return (
    <div className="workspace-shell">
      <div className="workspace-hero card">
        <div className="workspace-breadcrumb">
          <Link href="/clients" className="breadcrumb-link">Clients</Link>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-current">{client.name}</span>
        </div>

        <div className="workspace-hero-body">
          <div className="workspace-hero-title-group">
            <h1 className="workspace-title">{client.name}</h1>
            <p className="workspace-subtitle">{client.summary || "Client workspace"}</p>
          </div>

          <div className="workspace-hero-chips">
            <span className="tag">{client.siteCount} app{client.siteCount === 1 ? "" : "s"}</span>
            <span className="tag">{client.memberCount} team member{client.memberCount === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>

      <div className="workspace-tab-bar card">
        <WorkspaceTabs tabs={tabs} />
      </div>

      <div className="workspace-content">{children}</div>
    </div>
  );
}
