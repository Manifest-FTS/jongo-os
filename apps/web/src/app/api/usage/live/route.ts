import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { getLiveUsage, getVisibleSiteIds } from "@/lib/usage-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage/live[?siteId=]
 *
 * Current CPU, memory and traffic per app, from two readings two seconds apart
 * (shared 20s cache — see getLiveUsage). Clients only ever receive their own
 * apps; host totals, platform overhead and unmapped containers are admin-only.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isPlatformAdmin = await isPlatformAdminEmail(session.user.email);
  const visible = await getVisibleSiteIds({ userId: session.user.id, isPlatformAdmin });
  const siteId = new URL(request.url).searchParams.get("siteId")?.trim() || null;
  if (siteId && visible && !visible.includes(siteId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const live = await getLiveUsage();
  if (!live) {
    return NextResponse.json({ ok: false, error: "Live readings are unavailable right now." }, { status: 503 });
  }

  const subjects = live.subjects.filter((s) => {
    if (siteId) return s.siteId === siteId;
    if (!s.siteId) return isPlatformAdmin;
    return !visible || visible.includes(s.siteId);
  });

  return NextResponse.json({
    ok: true,
    takenAt: live.takenAt,
    ...(isPlatformAdmin ? { host: live.host, hostCpuCores: live.cpuCores, hostMemTotalBytes: live.memTotalBytes } : {}),
    subjects: subjects.map((s) => ({
      siteId: s.siteId,
      label: s.label,
      kind: s.siteId ? "app" : s.subjectKey.startsWith("unmapped:") ? "unmapped" : "infra",
      cpuCores: s.cpuCores,
      memoryBytes: s.memoryBytes,
      memoryLimitBytes: s.memoryLimitBytes,
      egressBytesPerSec: s.egressBytesPerSec,
      containers: s.containers
    }))
  });
}
