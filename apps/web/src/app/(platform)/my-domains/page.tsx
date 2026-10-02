import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/domain-search";
import { getDomainViewer } from "@/lib/domain-access";
import { getManageableOrganizations, getVisibleOrganizationIds, OPERATION_LABEL } from "@/lib/domain-orders";
import { CHARGE_STATUS, DNS_STATUS, DOMAIN_STATUS, chargeMargin, daysUntil, formatDate, isRevenue, statusOf } from "@/lib/domain-display";
import { getBalance, namecheapMode } from "@/lib/namecheap";
import { isCloudflareConfigured } from "@/lib/cloudflare";
import { readMarkupPercent, type DomainOperation } from "@/lib/domain-pricing";

/**
 * Domains: every domain the viewer's clients own through Jongo, with status,
 * renewal date and DNS state. Platform admins also see the billing audit:
 * Namecheap's cost against what each client paid, per charge.
 */

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

function Chip({ label, tone }: { label: string; tone: string }) {
  return <span className={`status-chip ${tone}`}>{label}</span>;
}

export default async function DomainsPage() {
  const viewer = await getDomainViewer();
  const db: any = await getDb();
  if (!viewer || !db) {
    return (
      <div className="page-stack">
        <article className="card">
          <p className="card-muted m-0">Sign in to see your domains.</p>
        </article>
      </div>
    );
  }

  const visible = await getVisibleOrganizationIds(viewer.userId, viewer.isPlatformAdmin);
  const manageable = await getManageableOrganizations(viewer.userId, viewer.isPlatformAdmin);
  const domains: any[] = await db.domain.findMany({
    where: { deletedAt: null, status: { not: "pending_payment" }, ...(visible ? { organizationId: { in: visible } } : {}) },
    include: { organization: { select: { name: true } } },
    orderBy: [{ expiresAt: "asc" }, { name: "asc" }]
  });

  const charges: any[] = viewer.isPlatformAdmin
    ? await db.domainCharge.findMany({
        where: { status: { notIn: ["pending_payment", "expired"] } },
        include: { domain: { select: { id: true, name: true, organization: { select: { name: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 200
      })
    : [];
  const balance = viewer.isPlatformAdmin ? await getBalance().catch(() => null) : null;

  const totals = charges
    .filter((charge) => isRevenue(charge.status))
    .reduce(
      (sum, charge) => {
        const { costCents, marginCents } = chargeMargin(charge);
        return { revenue: sum.revenue + charge.clientCents, cost: sum.cost + costCents, margin: sum.margin + marginCents };
      },
      { revenue: 0, cost: 0, margin: 0 }
    );

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Domains</h1>
          <p className="page-subtitle">Registration, renewal dates and DNS for your clients&apos; domains.</p>
        </div>
        {manageable.length > 0 ? (
          <div className="page-head-actions">
            <Link href="/my-domains/new" className="btn">
              Register or transfer a domain
            </Link>
          </div>
        ) : null}
      </div>

      <article className="card">
        {domains.length === 0 ? (
          <p className="card-muted m-0">
            No domains yet. {manageable.length > 0 ? "Register a new one or transfer one you already own." : ""}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[0.88rem]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="font-semibold py-2 pr-3">Domain</th>
                  <th className="font-semibold py-2 pr-3">Client</th>
                  <th className="font-semibold py-2 pr-3">Status</th>
                  <th className="font-semibold py-2 pr-3">DNS</th>
                  <th className="font-semibold py-2 pr-3">Renews</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => {
                  const days = daysUntil(domain.expiresAt);
                  const status = statusOf(DOMAIN_STATUS, domain.status);
                  const dns = domain.dnsStatus ? statusOf(DNS_STATUS, domain.dnsStatus) : null;
                  return (
                    <tr key={domain.id} className="border-0 border-t border-solid border-border">
                      <td className="py-2.5 pr-3">
                        <Link href={`/my-domains/${domain.id}`} className="action-link font-semibold">
                          {domain.name}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3">{domain.organization?.name ?? "—"}</td>
                      <td className="py-2.5 pr-3">
                        <Chip {...status} />
                      </td>
                      <td className="py-2.5 pr-3">{dns ? <Chip {...dns} /> : <span className="text-muted">—</span>}</td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {formatDate(domain.expiresAt)}
                        {days !== null && days <= 30 ? (
                          <span className={`ml-2 text-[0.78rem] font-semibold ${days < 0 ? "text-danger-text" : "text-warn-text"}`}>
                            {days < 0 ? "expired" : `in ${days} day${days === 1 ? "" : "s"}`}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>

      {viewer.isPlatformAdmin ? (
        <article className="card">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="card-title m-0">Domain billing audit</h3>
            <p className="card-muted m-0 text-[0.82rem]">
              Namecheap {namecheapMode()} · balance {balance?.availableCents != null ? formatCents(balance.availableCents) : "unknown"} · Cloudflare{" "}
              {isCloudflareConfigured() ? "connected" : "not connected"} · markup {readMarkupPercent()}%
            </p>
          </div>

          <div className="grid gap-3 mt-4 grid-cols-3 max-w-[560px]">
            <div>
              <p className="metric-label m-0">Clients paid</p>
              <p className="mt-1 mb-0 text-[1.15rem] font-bold text-metric">{formatCents(totals.revenue)}</p>
            </div>
            <div>
              <p className="metric-label m-0">Namecheap cost</p>
              <p className="mt-1 mb-0 text-[1.15rem] font-bold text-metric">{formatCents(totals.cost)}</p>
            </div>
            <div>
              <p className="metric-label m-0">Margin</p>
              <p className="mt-1 mb-0 text-[1.15rem] font-bold text-metric">{formatCents(totals.margin)}</p>
            </div>
          </div>

          {charges.length === 0 ? (
            <p className="card-muted mt-4 mb-0">No domain charges yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[0.84rem] tabular-nums">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="font-semibold py-2 pr-3">Date</th>
                    <th className="font-semibold py-2 pr-3">Domain</th>
                    <th className="font-semibold py-2 pr-3">Client</th>
                    <th className="font-semibold py-2 pr-3">Order</th>
                    <th className="font-semibold py-2 pr-3 text-right">Namecheap cost</th>
                    <th className="font-semibold py-2 pr-3 text-right">Markup</th>
                    <th className="font-semibold py-2 pr-3 text-right">Client paid</th>
                    <th className="font-semibold py-2 pr-3 text-right">Margin</th>
                    <th className="font-semibold py-2 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {charges.map((charge) => {
                    const { costCents, marginCents, costIsActual } = chargeMargin(charge);
                    const status = statusOf(CHARGE_STATUS, charge.status);
                    return (
                      <tr key={charge.id} className="border-0 border-t border-solid border-border align-top">
                        <td className="py-2 pr-3 whitespace-nowrap">{formatDate(charge.createdAt)}</td>
                        <td className="py-2 pr-3">
                          <Link href={`/my-domains/${charge.domain.id}`} className="action-link">
                            {charge.domain.name}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">{charge.domain.organization?.name ?? "—"}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {OPERATION_LABEL[charge.operation as DomainOperation] ?? charge.operation} · {charge.years} yr
                        </td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">
                          {formatCents(costCents)}
                          <span className="block text-[0.72rem] text-muted">{costIsActual ? "charged" : `quoted ${formatCents(charge.wholesaleCents)}`}</span>
                        </td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">
                          {charge.markupPercent}%<span className="block text-[0.72rem] text-muted">{formatCents(charge.markupCents)}</span>
                        </td>
                        <td className="py-2 pr-3 text-right">{formatCents(charge.clientCents)}</td>
                        <td className={`py-2 pr-3 text-right font-semibold ${marginCents < 0 ? "text-danger-text" : ""}`}>
                          {isRevenue(charge.status) ? formatCents(marginCents) : "—"}
                        </td>
                        <td className="py-2 pr-3">
                          <Chip {...status} />
                          {charge.error ? <span className="block mt-1 text-[0.74rem] text-muted max-w-[260px]">{charge.error}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="card-muted mt-3 mb-0 text-[0.78rem]">
            Cost is what Namecheap actually charged once the order is placed (its ChargedAmount), and the quoted wholesale price
            before that. Refunded and failed orders are not counted in the totals.
          </p>
        </article>
      ) : null}
    </div>
  );
}
