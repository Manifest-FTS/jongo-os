import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/domain-search";
import { getDomainViewer, loadDomainForViewer } from "@/lib/domain-access";
import { OPERATION_LABEL } from "@/lib/domain-orders";
import { CHARGE_STATUS, DNS_STATUS, DOMAIN_STATUS, chargeMargin, daysUntil, formatDate, isRevenue, statusOf } from "@/lib/domain-display";
import type { DomainOperation } from "@/lib/domain-pricing";
import PageAutoRefresh from "@/components/PageAutoRefresh";
import DnsRecordsPanel from "@/components/domains/DnsRecordsPanel";
import RenewDomainPanel from "@/components/domains/RenewDomainPanel";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Params = {
  params: Promise<{ domainId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DomainDetailPage({ params, searchParams }: Params) {
  const { domainId } = await params;
  const sp = (await searchParams) ?? {};
  const viewer = await getDomainViewer();
  const found = viewer ? await loadDomainForViewer(domainId, viewer) : null;
  if (!viewer || !found) notFound();

  const db: any = await getDb();
  const domain = found.domain;
  const [organization, charges] = await Promise.all([
    db.organization.findUnique({ where: { id: domain.organizationId }, select: { name: true } }),
    db.domainCharge.findMany({ where: { domainId: domain.id, status: { not: "pending_payment" } }, orderBy: { createdAt: "desc" } })
  ]);

  const status = statusOf(DOMAIN_STATUS, domain.status);
  const dns = domain.dnsStatus ? statusOf(DNS_STATUS, domain.dnsStatus) : null;
  const days = daysUntil(domain.expiresAt);
  const inFlight = ["registering", "transfer_pending", "pending_payment"].includes(domain.status) || charges.some((c: any) => ["paid", "fulfilling"].includes(c.status));
  const justPaid = (Array.isArray(sp.checkout) ? sp.checkout[0] : sp.checkout) === "success";

  return (
    <div className="page-stack">
      {inFlight ? <PageAutoRefresh intervalMs={10000} /> : null}

      <div className="page-head">
        <div>
          <h1 className="page-title">{domain.name}</h1>
          <p className="page-subtitle">{organization?.name ?? "Client"}</p>
        </div>
        <div className="page-head-actions">
          <Link href="/my-domains" className="btn btn-secondary">
            All domains
          </Link>
        </div>
      </div>

      {justPaid ? (
        <p className="m-0 px-3 py-2 rounded-lg border border-solid border-healthy-border bg-healthy-bg text-healthy-text text-[0.88rem]">
          Payment received. {inFlight ? "We are placing the order with the registrar now; this page updates by itself." : "The order is done."}
        </p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="card">
          <p className="metric-label m-0">Status</p>
          <p className="mt-2 mb-0">
            <span className={`status-chip ${status.tone}`}>{status.label}</span>
          </p>
        </article>
        <article className="card">
          <p className="metric-label m-0">Renews</p>
          <p className="mt-1 mb-0 text-[1.1rem] font-bold text-metric">{formatDate(domain.expiresAt)}</p>
          {days !== null ? (
            <p className={`mt-0.5 mb-0 text-[0.8rem] ${days < 30 ? "text-warn-text font-semibold" : "text-muted"}`}>
              {days < 0 ? "Expired" : `In ${days} day${days === 1 ? "" : "s"}`}
            </p>
          ) : null}
        </article>
        <article className="card">
          <p className="metric-label m-0">DNS</p>
          <p className="mt-2 mb-0">{dns ? <span className={`status-chip ${dns.tone}`}>{dns.label}</span> : <span className="text-muted">Not set up</span>}</p>
          {domain.dnsStatus === "pending" ? (
            <p className="mt-1 mb-0 text-[0.78rem] text-muted">New nameservers can take a few hours to take effect worldwide.</p>
          ) : null}
        </article>
        <article className="card">
          <p className="metric-label m-0">Nameservers</p>
          {domain.nameservers?.length ? (
            <ul className="mt-1 mb-0 pl-0 list-none text-[0.84rem] font-mono">
              {domain.nameservers.map((ns: string) => (
                <li key={ns}>{ns}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 mb-0 text-muted text-[0.84rem]">Set once DNS is ready.</p>
          )}
        </article>
      </section>

      {domain.lastError ? (
        <p className="m-0 px-3 py-2 rounded-lg border border-solid border-warn-border bg-warn-bg text-warn-text text-[0.86rem]">{domain.lastError}</p>
      ) : null}

      {found.canManage && ["active", "expired"].includes(domain.status) ? <RenewDomainPanel domain={domain.name} organizationId={domain.organizationId} /> : null}

      <DnsRecordsPanel domainId={domain.id} zoneName={domain.name} canManage={found.canManage} zoneReady={Boolean(domain.cloudflareZoneId)} />

      <article className="card">
        <h3 className="card-title m-0">Billing history</h3>
        {charges.length === 0 ? (
          <p className="card-muted mt-2 mb-0">No charges yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[0.86rem] tabular-nums">
              <thead>
                <tr className="text-left text-muted">
                  <th className="font-semibold py-2 pr-3">Date</th>
                  <th className="font-semibold py-2 pr-3">Order</th>
                  <th className="font-semibold py-2 pr-3 text-right">Paid</th>
                  {viewer.isPlatformAdmin ? (
                    <>
                      <th className="font-semibold py-2 pr-3 text-right">Namecheap cost</th>
                      <th className="font-semibold py-2 pr-3 text-right">Margin</th>
                    </>
                  ) : null}
                  <th className="font-semibold py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((charge: any) => {
                  const chip = statusOf(CHARGE_STATUS, charge.status);
                  const { costCents, marginCents, costIsActual } = chargeMargin(charge);
                  return (
                    <tr key={charge.id} className="border-0 border-t border-solid border-border align-top">
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDate(charge.createdAt)}</td>
                      <td className="py-2 pr-3">
                        {OPERATION_LABEL[charge.operation as DomainOperation] ?? charge.operation} · {charge.years} yr
                      </td>
                      <td className="py-2 pr-3 text-right">{formatCents(charge.clientCents)}</td>
                      {viewer.isPlatformAdmin ? (
                        <>
                          <td className="py-2 pr-3 text-right">
                            {formatCents(costCents)}
                            <span className="block text-[0.72rem] text-muted">{costIsActual ? "charged" : "quoted"}</span>
                          </td>
                          <td className="py-2 pr-3 text-right">{isRevenue(charge.status) ? `${formatCents(marginCents)} (${charge.markupPercent}%)` : "—"}</td>
                        </>
                      ) : null}
                      <td className="py-2 pr-3">
                        <span className={`status-chip ${chip.tone}`}>{chip.label}</span>
                        {charge.error ? <span className="block mt-1 text-[0.76rem] text-muted max-w-[320px]">{charge.error}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </div>
  );
}
