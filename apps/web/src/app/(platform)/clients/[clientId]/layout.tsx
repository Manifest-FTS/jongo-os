import { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import WorkspaceTabs, { type WorkspaceTab } from "@/components/navigation/WorkspaceTabs";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, isClientAdmin, listSiteDirectory } from "@/lib/repositories";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ clientId: string }>;
};

export default async function ClientWorkspaceLayout({ children, params }: LayoutProps) {
  const { clientId } = await params;
  const session = await auth();

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
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };
  const visibleSiteCount = client.dataSource === "db"
    ? (await listSiteDirectory(viewer)).filter((site) => site.clientId === client.id).length
    : client.siteCount;

  const tabs: WorkspaceTab[] = [
    { name: "Overview", href: `/clients/${clientId}`, match: "exact" },
    { name: "Apps", href: `/clients/${clientId}/apps` },
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
            <span className="tag">{visibleSiteCount} app{visibleSiteCount === 1 ? "" : "s"}</span>
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
