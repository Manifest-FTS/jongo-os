import React from "react";
import ClientBillingView from "@/components/billing/ClientBillingView";
import { billingViewer } from "@/lib/client-billing-http";
import { BillingInputError } from "@/lib/client-billing";

export const dynamic = "force-dynamic";

export default async function ClientBillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  try { await billingViewer(); }
  catch (error) {
    return <article className="card"><h1 className="page-title">Access denied</h1><p role="alert">{error instanceof BillingInputError && error.status === 401 ? "Sign in first." : "Client billing is restricted to super admins. Technical administrator access does not grant financial access."}</p></article>;
  }
  const params = await searchParams;
  return <div className="page-stack">
    <div className="page-head"><div><h1 className="page-title">Client billing</h1><p className="page-subtitle">Client bookkeeping, manual overrides and external invoice references. Separate from per-account subscriptions.</p></div></div>
    <ClientBillingView initialClientId={typeof params.clientId === "string" ? params.clientId : ""} />
  </div>;
}