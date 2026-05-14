import { NextResponse } from "next/server";
import { getCoolifyOverview } from "@/lib/coolify";

export async function GET() {
  try {
    const overview = await getCoolifyOverview();

    return NextResponse.json({
      ok: true,
      mode: overview.mode,
      generatedAt: overview.generatedAt,
      stats: overview.stats,
      sites: overview.sites.map((site) => ({
        id: site.id,
        name: site.name,
        status: site.status,
        productionStatus: site.productionStatus,
        stagingStatus: site.stagingStatus
      }))
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status fetch failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
