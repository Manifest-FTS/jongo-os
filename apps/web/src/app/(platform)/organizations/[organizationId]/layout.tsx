import { ReactNode } from "react";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ organizationId: string }>;
};

export default async function ClientWorkspaceLayout({ children, params }: LayoutProps) {
  await params;
  return <>{children}</>;
}
