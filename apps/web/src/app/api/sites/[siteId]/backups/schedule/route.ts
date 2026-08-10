import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { isValidBackupFrequency, scheduledBackupsDefaultEnabled, summarizeBackupSchedule } from "@/lib/backup-schedule";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

/**
 * Update this app's automatic-backup schedule.
 *
 * Setting `enabled: null` returns the site to following the platform default,
 * which is a genuinely different state from "off" — see the nullable
 * backupScheduleEnabled column.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { siteId } = await params;
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspace = await getSiteWorkspace(siteId, {
      userId: session.user.id,
      email: session.user.email
    });
    if (!workspace) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }

    const permissionSnapshot = await resolveSitePermissionSnapshot({
      siteId,
      workspace,
      viewer: { userId: session.user.id, email: session.user.email }
    });
    if (!permissionSnapshot.canManageBackups) {
      return NextResponse.json(
        { error: "You do not have permission to change the backup schedule" },
        { status: 403 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const data: Record<string, unknown> = {};

    if ("enabled" in body) {
      const enabled = body.enabled;
      if (enabled !== null && typeof enabled !== "boolean") {
        return NextResponse.json(
          { error: "enabled must be true, false, or null to follow the platform default." },
          { status: 400 }
        );
      }
      data.backupScheduleEnabled = enabled;
    }

    if ("frequencyHours" in body) {
      const hours = typeof body.frequencyHours === "number" ? body.frequencyHours : Number(body.frequencyHours);
      if (!isValidBackupFrequency(hours)) {
        return NextResponse.json(
          { error: "frequencyHours must be one of 6, 12, 24 or 168." },
          { status: 400 }
        );
      }
      data.backupFrequencyHours = hours;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    if (!db) {
      return NextResponse.json(
        { error: "Backup scheduling is not available in this environment yet." },
        { status: 503 }
      );
    }

    // Read the resolved on/off BEFORE the write so the notification fires only
    // on an actual transition. Without this, saving the same settings twice
    // emails the whole team twice about a change that did not happen.
    const before = await (db as any).site.findUnique({
      where: { id: workspace.id },
      select: { backupScheduleEnabled: true, backupFrequencyHours: true, lastScheduledBackupAt: true }
    });

    const updated = await (db as any).site.update({
      where: { id: workspace.id },
      select: {
        backupScheduleEnabled: true,
        backupFrequencyHours: true,
        lastScheduledBackupAt: true
      },
      data
    });

    const schedule = summarizeBackupSchedule({
      ...updated,
      platformDefaultEnabled: scheduledBackupsDefaultEnabled()
    });

    const wasEnabled = before
      ? summarizeBackupSchedule({ ...before, platformDefaultEnabled: scheduledBackupsDefaultEnabled() }).enabled
      : null;

    if (wasEnabled !== null && wasEnabled !== schedule.enabled) {
      const { notifyBackupEvent } = await import("@/lib/site-notify");
      await notifyBackupEvent({
        siteId: workspace.id,
        event: schedule.enabled ? "schedule_enabled" : "schedule_disabled",
        frequencyLabel: schedule.frequencyLabel
      });
    }

    return NextResponse.json({ ok: true, schedule });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not update the schedule: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
