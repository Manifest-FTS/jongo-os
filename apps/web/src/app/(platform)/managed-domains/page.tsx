import React from "react";
import Link from "next/link";
import ManagedDomainsView from "@/components/billing/ManagedDomainsView";
import { billingViewer } from "@/lib/client-billing-http";
import { canViewBilling } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function ManagedDomainsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let viewer;
  try { viewer = await billingViewer(false); }
  catch { return <article className="card"><h1 className="page-title">Access denied</h1><p role="alert">Sign in with an active account to view managed inventory.</p></article>; }
  const superAdmin = canViewBilling(viewer);
  const params = await searchParams;
  const unassigned = params.assignment === "unassigned";
  if (unassigned && !superAdmin) return <article className="card"><h1 className="page-title">Access denied</h1><p role="alert">The unassigned domain mapping view is restricted to super admins.</p></article>;
  return <div className="page-stack">
    <div className="page-head"><div><h1 className="page-title">Managed domains</h1><p className="page-subtitle">Managed inventory, expiry, registrar auto-renew and DNS. Registrar inventory is read from the local database.</p></div>
      <div className="page-head-actions"><Link className="btn btn-secondary" href="/my-domains">Technical Domains</Link>{superAdmin ? <Link className="btn" href="/client-billing">Client billing</Link> : null}</div>
    </div>
    <ManagedDomainsView superAdmin={superAdmin} initialUnassigned={unassigned} />
  </div>;
}