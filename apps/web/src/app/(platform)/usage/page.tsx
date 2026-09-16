import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { getUsageReport, getVisibleSiteIds, type UsageRow } from "@/lib/usage-store";
import {
  averageCores,
  describeCoverage,
  formatBytes,
  formatCores,
  formatDiskPercent,
  formatPercent,
  formatUsd,
  formatVcpuHours,
  parseWindow
} from "@/lib/usage-format";
import UsageFilters from "@/components/usage/UsageFilters";
import UsageMeter from "@/components/usage/UsageMeter";
import UsageColumnChart from "@/components/usage/UsageColumnChart";
import UsageLivePanel from "@/components/usage/UsageLivePanel";

/**
 * Usage — compute, memory, egress and storage.
 *
 * Platform admins see the whole server: every client, platform overhead, and
 * Coolify resources no Jongo app owns (capacity nobody is billed for), with the
 * server's capacity as the denominator and an optional cost allocation.
 * Everyone else sees only the apps they can already see in Jongo.
 */

export const dynamic = "force-dynamic";

type Params = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstParam(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && UUID.test(v) ? v : null;
}

type Group = {
  key: string;
  label: string;
  href: string | null;
  kind: UsageRow["kind"] | "client";
  cpuCoreSeconds: number;
  memAvgBytes: number;
  memPeakBytes: number;
  egressBytes: number;
  diskBytes: number;
  hours: number;
};

function toGroup(row: UsageRow, href: string | null): Group {
  return {
    key: row.key, label: row.label, href, kind: row.kind,
    cpuCoreSeconds: row.cpuCoreSeconds, memAvgBytes: row.memAvgBytes, memPeakBytes: row.memPeakBytes,
    egressBytes: row.egressBytes, diskBytes: row.diskBytes, hours: row.hours
  };
}

/** Clients: an app-row sum. Peak is a sum of each app's own peak — an upper bound. */
function byClient(rows: UsageRow[], params: URLSearchParams): Group[] {
  const map = new Map<string, Group>();
  for (const row of rows) {
    const id = row.organizationId ?? "none";
    const g = map.get(id) ?? {
      key: `client:${id}`, label: row.organizationName ?? "No client", kind: "client" as const,
      href: row.organizationId ? `/usage?${new URLSearchParams({ ...Object.fromEntries(params), client: row.organizationId }).toString()}` : null,
      cpuCoreSeconds: 0, memAvgBytes: 0, memPeakBytes: 0, egressBytes: 0, diskBytes: 0, hours: 0
    };
    g.cpuCoreSeconds += row.cpuCoreSeconds;
    g.memAvgBytes += row.memAvgBytes;
    g.memPeakBytes += row.memPeakBytes;
    g.egressBytes += row.egressBytes;
    g.diskBytes += row.diskBytes;
    g.hours = Math.max(g.hours, row.hours);
    map.set(id, g);
  }
  return [...map.values()];
}

function ShareBar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <span className="inline-flex items-center gap-2 justify-end w-full">
      <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="w-16 h-1.5 shrink-0" aria-hidden>
        <rect x={0} y={0} width={100} height={6} rx={3} fill="#e3efd9" />
        <rect x={0} y={0} width={pct} height={6} rx={3} fill="#4f8a2f" />
      </svg>
      <span className="w-12 text-right">{formatPercent(fraction)}</span>
    </span>
  );
}

export default async function UsagePage({ searchParams }: Params) {
  const sp = (await searchParams) ?? {};
  const days = parseWindow(sp.window);
  const session = await auth();
  const isPlatformAdmin = await isPlatformAdminEmail(session?.user?.email);
  const visible = await getVisibleSiteIds({ userId: session?.user?.id, isPlatformAdmin });

  // Filter options come from the apps this viewer can see.
  const db = await getDb();
  const apps: Array<{ id: string; name: string; organizationId: string; organization: { name: string } }> = db
    ? await db.site.findMany({
        where: { deletedAt: null, parentSiteId: null, ...(visible ? { id: { in: visible } } : {}) },
        select: { id: true, name: true, organizationId: true, organization: { select: { name: true } } },
        orderBy: { name: "asc" }
      })
    : [];
  const clientMap = new Map<string, string>();
  for (const a of apps) clientMap.set(a.organizationId, a.organization.name);
  const clients = [...clientMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  // Never trust a filter id the viewer could not have picked.
  const requestedClient = firstParam(sp.client);
  const requestedApp = firstParam(sp.app);
  const clientId = requestedClient && clientMap.has(requestedClient) ? requestedClient : null;
  const appId = requestedApp && apps.some((a) => a.id === requestedApp) ? requestedApp : null;
  const fleetView = isPlatformAdmin && !clientId && !appId;

  const report = await getUsageReport({
    days,
    visibleSiteIds: visible,
    organizationId: clientId,
    siteId: appId,
    includeInfra: fleetView
  });

  const rows = report.rows;
  const appRows = rows.filter((r) => r.kind === "app");
  const total = rows.reduce(
    (t, r) => ({
      cpu: t.cpu + r.cpuCoreSeconds,
      mem: t.mem + r.memAvgBytes,
      memHours: t.memHours + r.memByteHours,
      egress: t.egress + r.egressBytes,
      disk: t.disk + r.diskBytes
    }),
    { cpu: 0, mem: 0, memHours: 0, egress: 0, disk: 0 }
  );
  const host = isPlatformAdmin ? report.hosts[0] ?? null : null;
  // Measured time, not whole hours: the first and current hours are partial.
  const coveredHours = report.measuredSeconds > 0 ? report.measuredSeconds / 3600 : Math.max(1, host?.hours ?? report.hoursCovered);
  const hasData = report.available && report.hoursCovered > 0 && rows.length > 0;

  // Optional cost allocation: the covered hours' share of the monthly bill,
  // split by each row's share of memory in use (RAM is what fills a shared
  // Docker host first). Allocating by share of USED memory means the rows sum
  // to the whole bill; idle capacity is shown separately on the server card.
  const monthlyCost = Number(process.env.USAGE_HOST_MONTHLY_COST_USD || "") || 0;
  const windowCost = isPlatformAdmin && monthlyCost > 0 ? monthlyCost * (coveredHours / 730) : 0;
  const memInUse = rows.reduce((a, r) => a + r.memAvgBytes, 0);
  const costFor = (memAvg: number) => (windowCost > 0 && memInUse > 0 ? windowCost * (memAvg / memInUse) : null);

  const paramsForLinks = new URLSearchParams();
  paramsForLinks.set("window", String(days));

  const tableRows: Group[] = fleetView
    ? [
        ...byClient(appRows, paramsForLinks).sort((a, b) => b.memAvgBytes - a.memAvgBytes),
        ...rows.filter((r) => r.kind === "unmapped").map((r) => toGroup(r, null)).sort((a, b) => b.memAvgBytes - a.memAvgBytes),
        ...rows.filter((r) => r.kind === "infra").map((r) => toGroup(r, null)).sort((a, b) => b.memAvgBytes - a.memAvgBytes)
      ]
    : appRows
        .map((r) => toGroup(r, r.siteId ? `/apps/${r.siteId}/usage?window=${days}` : null))
        .sort((a, b) => b.memAvgBytes - a.memAvgBytes);

  const firstData = report.firstDataAt
    ? report.firstDataAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Usage</h1>
          <p className="page-subtitle">
            {isPlatformAdmin
              ? "Compute, memory, bandwidth and storage across the whole server."
              : "Compute, memory, bandwidth and storage for your apps."}
          </p>
        </div>
      </div>

      <UsageFilters
        days={days}
        clients={isPlatformAdmin || clients.length > 1 ? clients : undefined}
        apps={apps.map((a) => ({ id: a.id, name: a.name, organizationId: a.organizationId }))}
        clientId={clientId}
        appId={appId}
      />

      {!hasData ? (
        <article className="card">
          <h3 className="card-title m-0">No usage recorded yet</h3>
          <p className="card-muted mt-2 mb-0">
            Readings are taken every few minutes from the server. Memory appears after the first reading; CPU and
            bandwidth need two readings, because they are measured as the difference between them. History starts
            from the first reading — it cannot be backfilled.
          </p>
        </article>
      ) : (
        <>
          <p className="card-muted m-0 text-[0.86rem]">
            {describeCoverage(coveredHours, days)}
            {firstData ? ` · collecting since ${firstData}` : ""}
            {fleetView ? " · totals include platform overhead and containers with no Jongo app" : ""}
          </p>

          <section className="grid">
            <UsageMeter
              label="Compute"
              value={total.cpu}
              valueText={formatVcpuHours(total.cpu)}
              detail={
                host
                  ? `avg ${formatCores(averageCores(total.cpu, coveredHours))} · ${formatPercent(total.cpu / (host.cpuCores * coveredHours * 3600))} of ${host.cpuCores} vCPU`
                  : `avg ${formatCores(averageCores(total.cpu, coveredHours))}`
              }
            />
            <UsageMeter
              label="Memory"
              value={total.mem}
              valueText={formatBytes(total.mem)}
              detail={
                host
                  ? `average in use · ${formatPercent(total.mem / host.memTotalBytes)} of ${formatBytes(host.memTotalBytes)}`
                  : `average in use · ${formatBytes(total.memHours)}-hours`
              }
            />
            <UsageMeter
              label="Egress bandwidth"
              value={total.egress}
              valueText={formatBytes(total.egress)}
              detail="sent by public-facing apps, before compression"
            />
            <UsageMeter
              label="App data"
              value={total.disk}
              valueText={formatBytes(total.disk)}
              detail={
                host
                  ? `apps' persistent volumes · server disk is ${formatDiskPercent(host.diskUsedFraction)} full (see Server)`
                  : "apps' persistent volumes, latest"
              }
            />
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <UsageColumnChart title="Compute per day" subtitle="vCPU-hours" format="vcpu-hours" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.cpuCoreSeconds }))} />
            <UsageColumnChart title="Memory per day" subtitle="average in use" format="bytes" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.memAvgBytes }))} />
            <UsageColumnChart title="Egress per day" subtitle="bytes served to visitors" format="bytes" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.egressBytes }))} />
            <UsageColumnChart title="App data per day" subtitle="apps' persistent volumes" format="bytes" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.diskBytes }))} />
          </section>

          <article className="card">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h3 className="card-title m-0">{fleetView ? "By client" : "By app"}</h3>
              <p className="card-muted m-0 text-[0.82rem]">Last {days} days · sorted by memory</p>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[0.86rem] tabular-nums !table">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="font-semibold py-2 pr-3">{fleetView ? "Client" : "App"}</th>
                    <th className="font-semibold py-2 pr-3 text-right">Compute</th>
                    <th className="font-semibold py-2 pr-3 text-right">Avg memory</th>
                    <th className="font-semibold py-2 pr-3 text-right">Peak memory</th>
                    <th className="font-semibold py-2 pr-3 text-right">Egress</th>
                    <th className="font-semibold py-2 pr-3 text-right">Storage</th>
                    {host ? <th className="font-semibold py-2 pr-3 text-right">Share of server RAM</th> : null}
                    {windowCost > 0 ? <th className="font-semibold py-2 text-right">Est. cost</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((g, i) => {
                    const sectionStart = fleetView && i > 0 && g.kind !== tableRows[i - 1].kind;
                    const cost = costFor(g.memAvgBytes);
                    return (
                      <tr key={g.key} className={`border-0 border-t border-solid ${sectionStart ? "border-border-strong" : "border-border"}`}>
                        <td className="py-2 pr-3">
                          {g.href ? <Link href={g.href} className="action-link">{g.label}</Link> : g.label}
                          {g.kind === "unmapped" ? <span className="ml-2 text-[0.75rem] text-muted">in Coolify, no Jongo app</span> : null}
                          {g.kind === "infra" ? <span className="ml-2 text-[0.75rem] text-muted">platform overhead</span> : null}
                        </td>
                        <td className="py-2 pr-3 text-right">{formatVcpuHours(g.cpuCoreSeconds)}</td>
                        <td className="py-2 pr-3 text-right">{formatBytes(g.memAvgBytes)}</td>
                        <td className="py-2 pr-3 text-right">{formatBytes(g.memPeakBytes)}</td>
                        <td className="py-2 pr-3 text-right">{formatBytes(g.egressBytes)}</td>
                        <td className="py-2 pr-3 text-right">{g.diskBytes ? formatBytes(g.diskBytes) : "—"}</td>
                        {host ? (
                          <td className="py-2 pr-3 text-right">
                            <ShareBar fraction={host.memTotalBytes ? g.memAvgBytes / host.memTotalBytes : 0} />
                          </td>
                        ) : null}
                        {windowCost > 0 ? <td className="py-2 text-right">{cost === null ? "—" : formatUsd(cost)}</td> : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="card-muted mt-3 mb-0 text-[0.8rem]">
              Egress is what each public-facing app sends to the proxy, before the proxy compresses it — real
              on-the-wire traffic is usually lower (the Server card shows what actually left the network
              interface). It is not billing-grade until the proxy reports bytes per app. An app's traffic to its own
              database is never counted. Memory is the working set (cache the kernel can reclaim is excluded), sampled every
              few minutes. {fleetView ? "A client's peak is the sum of its apps' peaks — an upper bound." : ""}
              {windowCost > 0 ? " Cost splits the server bill for the covered hours by share of memory in use." : ""}
            </p>
          </article>

          {host ? (
            <article className="card">
              <h3 className="card-title m-0">Server</h3>
              <p className="card-muted mt-1 mb-0 text-[0.85rem]">{host.host} · over the covered hours</p>
              <div className="grid gap-4 mt-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="metric-label m-0">CPU busy</p>
                  <p className="mt-1 mb-0 text-[1.2rem] font-bold text-metric">
                    {formatPercent(host.cpuBusySeconds / (host.cpuCores * (host.coveredSeconds || host.hours * 3600)))}
                  </p>
                  <p className="mt-0.5 mb-0 text-[0.8rem] text-muted">of {host.cpuCores} vCPU, on average</p>
                </div>
                <div>
                  <p className="metric-label m-0">Memory used</p>
                  <p className="mt-1 mb-0 text-[1.2rem] font-bold text-metric">{formatBytes(host.memUsedAvgBytes)}</p>
                  <p className="mt-0.5 mb-0 text-[0.8rem] text-muted">
                    peak {formatBytes(host.memUsedPeakBytes)} of {formatBytes(host.memTotalBytes)} ·{" "}
                    {formatBytes(Math.max(0, host.memTotalBytes - host.memUsedPeakBytes))} never used
                  </p>
                </div>
                <div>
                  <p className="metric-label m-0">Disk used</p>
                  <p
                    className={`mt-1 mb-0 text-[1.2rem] font-bold ${host.diskUsedFraction >= 0.8 ? "text-warn-text" : "text-metric"}`}
                  >
                    {formatDiskPercent(host.diskUsedFraction)}
                  </p>
                  <p className="mt-0.5 mb-0 text-[0.8rem] text-muted">
                    {formatBytes(host.diskUsedBytes)} of {formatBytes(host.diskTotalBytes)}
                    {host.diskPeakFraction24h !== null ? (
                      <>
                        {" · "}
                        <span className={host.diskPeakFraction24h >= 0.8 ? "font-semibold text-warn-text" : undefined}>
                          peak {formatDiskPercent(host.diskPeakFraction24h)} in the last 24 h
                        </span>
                      </>
                    ) : null}
                  </p>
                  <p className="mt-0.5 mb-0 text-[0.8rem] text-muted">
                    Measured like Coolify&apos;s disk alert. App data is {formatBytes(total.disk)}; the rest is
                    images, backups and logs.
                  </p>
                </div>
                <div>
                  <p className="metric-label m-0">Server egress</p>
                  <p className="mt-1 mb-0 text-[1.2rem] font-bold text-metric">{formatBytes(host.netTxBytes)}</p>
                  <p className="mt-0.5 mb-0 text-[0.8rem] text-muted">
                    all traffic leaving the server, including offsite backups · apps {formatBytes(total.egress)}
                  </p>
                </div>
              </div>
            </article>
          ) : null}
        </>
      )}

      <UsageLivePanel limit={isPlatformAdmin ? 12 : 10} />
    </div>
  );
}
