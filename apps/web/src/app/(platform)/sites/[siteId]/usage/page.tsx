import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { getUsageReport } from "@/lib/usage-store";
import { getUsageLimits } from "@/lib/usage-limits";
import {
  averageCores,
  describeCoverage,
  formatBytes,
  formatCores,
  formatVcpuHours,
  parseWindow
} from "@/lib/usage-format";
import UsageFilters from "@/components/usage/UsageFilters";
import UsageMeter from "@/components/usage/UsageMeter";
import UsageColumnChart from "@/components/usage/UsageColumnChart";
import UsageLivePanel from "@/components/usage/UsageLivePanel";

/**
 * One app's usage, Vercel-style: four meters, a daily chart for each, and what
 * it is using right now. A nested database is counted as part of its app.
 *
 * Access is getSiteWorkspace's: if you can open the app, you can see its usage.
 */

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ siteId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AppUsagePage({ params, searchParams }: Params) {
  const { siteId } = await params;
  const sp = (await searchParams) ?? {};
  const days = parseWindow(sp.window);
  const session = await auth();
  const workspace = await getSiteWorkspace(siteId, { userId: session?.user?.id, email: session?.user?.email });
  if (!workspace) notFound();

  if (!UUID.test(workspace.id)) {
    return (
      <div className="page-stack">
        <article className="card">
          <p className="card-muted m-0">Usage is recorded for apps registered in Jongo. This app is only known to Coolify so far.</p>
        </article>
      </div>
    );
  }

  const [report, limits] = await Promise.all([
    getUsageReport({ days, visibleSiteIds: null, siteId: workspace.id, includeInfra: false }),
    getUsageLimits({ siteId: workspace.id })
  ]);

  const row = report.rows[0];
  // Measured time, not whole hours: the first and current hours are partial.
  const hours = report.measuredSeconds > 0 ? report.measuredSeconds / 3600 : Math.max(1, row?.hours ?? report.hoursCovered);
  const hasData = report.available && Boolean(row);

  return (
    <div className="page-stack">
      <UsageFilters days={days} />

      {!hasData ? (
        <article className="card">
          <h3 className="card-title m-0">No usage recorded yet</h3>
          <p className="card-muted mt-2 mb-0">
            Readings are taken every few minutes. Memory shows after the first reading; CPU and bandwidth after the
            second, because they are measured as the difference between readings.
          </p>
        </article>
      ) : (
        <>
          <p className="card-muted m-0 text-[0.86rem]">{describeCoverage(hours, days)}</p>

          <section className="grid">
            <UsageMeter
              label="Memory"
              value={row.memAvgBytes}
              valueText={formatBytes(row.memAvgBytes)}
              limit={limits?.memoryBytes}
              limitText={limits?.memoryBytes ? formatBytes(limits.memoryBytes) : undefined}
              detail={`average in use · peak ${formatBytes(row.memPeakBytes)}`}
            />
            <UsageMeter
              label="CPU"
              value={row.cpuCoreSeconds / 3600}
              valueText={formatCores(averageCores(row.cpuCoreSeconds, hours))}
              limit={limits?.vcpuHours}
              limitText={limits?.vcpuHours ? `${limits.vcpuHours} vCPU-h` : undefined}
              detail={`average load · ${formatVcpuHours(row.cpuCoreSeconds)} in total`}
            />
            <UsageMeter
              label="Egress bandwidth"
              value={row.egressBytes}
              valueText={formatBytes(row.egressBytes)}
              limit={limits?.egressBytes}
              limitText={limits?.egressBytes ? formatBytes(limits.egressBytes) : undefined}
              detail={`sent to visitors before compression · last ${days} days`}
            />
            <UsageMeter
              label="Storage"
              value={row.diskBytes}
              valueText={row.diskBytes ? formatBytes(row.diskBytes) : "—"}
              limit={limits?.storageBytes}
              limitText={limits?.storageBytes ? formatBytes(limits.storageBytes) : undefined}
              detail={row.diskBytes ? "persistent volumes, latest measurement" : "measured hourly — not measured yet"}
            />
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <UsageColumnChart title="Memory per day" subtitle="average in use" format="bytes" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.memAvgBytes }))} />
            <UsageColumnChart title="Compute per day" subtitle="vCPU-hours" format="vcpu-hours" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.cpuCoreSeconds }))} />
            <UsageColumnChart title="Egress per day" subtitle="bytes served to visitors" format="bytes" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.egressBytes }))} />
            <UsageColumnChart title="Storage per day" subtitle="persistent volumes" format="bytes" days={days}
              points={report.daily.map((d) => ({ day: d.day, value: d.diskBytes }))} />
          </section>
        </>
      )}

      <UsageLivePanel siteId={workspace.id} />
    </div>
  );
}
