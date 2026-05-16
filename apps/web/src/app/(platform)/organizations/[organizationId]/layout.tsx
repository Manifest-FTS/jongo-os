import { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import WorkspaceTabs, { type WorkspaceTab } from "@/components/navigation/WorkspaceTabs";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace } from "@/lib/repositories";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ organizationId: string }>;
};

export default async function ClientWorkspaceLayout({ children, params }: LayoutProps) {
  const { organizationId } = await params;
  const session = await auth();

  const client = await getClientWorkspace(organizationId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }

  const tabs: WorkspaceTab[] = [
    { name: "Overview", href: `/organizations/${organizationId}`, match: "exact" },
    { name: "Apps", href: `/organizations/${organizationId}/apps` },
    { name: "Team", href: `/organizations/${organizationId}/team` },
    { name: "Settings", href: `/organizations/${organizationId}/settings` }
  ];

  return (
    <div className="workspace-shell">
      <div className="workspace-hero card">
        <div className="workspace-breadcrumb">
          <Link href="/organizations" className="breadcrumb-link">Clients</Link>
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
