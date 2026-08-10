/**
 * Starting a site backup.
 *
 * Extracted from the on-demand ("+") route because promote-to-production now
 * starts one too. Two copies of this would drift, and the parts that matter if
 * they drift are the ones that protect data: the refusal to stack a second
 * backup over a running one, and the resource checks that decide there is
 * anything to capture at all. A promote-triggered backup that skipped those
 * would be exactly the backup you cannot rely on.
 *
 * The job is spawned DETACHED and reports its own outcome to
 * /api/ops/site-backup-record when it finishes, so this returns as soon as the
 * child is running. Callers get a backup id to poll, never a completed backup.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { hasCoolifyBackupableState } from "@/lib/coolify";
import { openJobLog } from "@/lib/job-log";

/**
 * The fields a backup needs; both callers already have these loaded.
 *
 * slug/name are optional because the site workspace type treats them as such,
 * and they are only cosmetic here — they make a Backblaze snapshot legible
 * instead of a bare uuid. Missing values fall back to the id rather than
 * reaching spawn as `undefined`, which would throw on argv.
 */
export type SiteBackupTarget = {
  id: string;
  slug?: string | null;
  name?: string | null;
  coolifyServiceUuid?: string | null;
};

export type StartSiteBackupFailureReason =
  | "not_linked"
  | "unsupported_resource_type"
  | "missing_config"
  | "script_missing"
  | "feature_unavailable"
  | "already_running";

export type StartSiteBackupResult =
  | { ok: true; backupId: string; message: string }
  | {
      ok: false;
      reason: StartSiteBackupFailureReason;
      message: string;
      /** Set for already_running, so callers can point at the backup in flight. */
      runningBackupId?: string;
    };

function hasValue(value?: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

function resolveScriptPath(name: string): string | null {
  const cwd = process.cwd();
  return [
    path.join(cwd, "scripts", name),
    path.join(cwd, "..", "scripts", name),
    path.join(cwd, "..", "..", "scripts", name)
  ].find((candidate) => existsSync(candidate)) ?? null;
}

export async function startSiteBackup(input: {
  site: SiteBackupTarget;
  /** 'manual' from the Backups tab, 'promote' when promote takes one first. */
  trigger: "manual" | "promote";
  /** Already normalized by the caller via normalizeBackupNote. */
  label: string | null;
}): Promise<StartSiteBackupResult> {
  const resourceUuid = input.site.coolifyServiceUuid?.trim();
  if (!resourceUuid) {
    return { ok: false, reason: "not_linked", message: "This app is not linked to a Coolify resource." };
  }

  // The backup captures whatever persistent state a resource has (files volumes
  // and/or databases). Reject only resources with neither — the script is the
  // final arbiter and will report "nothing to back up" if it finds nothing.
  if (!(await hasCoolifyBackupableState(resourceUuid))) {
    return {
      ok: false,
      reason: "unsupported_resource_type",
      message: "This resource has no files or database to back up."
    };
  }

  if (!hasValue(process.env.STAGING_SYNC_SSH_HOST) && !hasValue(process.env.COOLIFY_SSH_HOST)) {
    return {
      ok: false,
      reason: "missing_config",
      message: "SSH host is not configured for server-side backups."
    };
  }

  const scriptPath = resolveScriptPath("site-backup.mjs");
  if (!scriptPath) {
    return { ok: false, reason: "script_missing", message: "Backup script not found." };
  }

  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db || !("siteBackup" in db)) {
    return {
      ok: false,
      reason: "feature_unavailable",
      message: "Site backup records are not available in this environment yet."
    };
  }

  // Refuse to stack concurrent backups for the same site.
  const running = await (db as any).siteBackup.findFirst({
    where: { siteId: input.site.id, status: "running" },
    select: { id: true }
  });
  if (running) {
    return {
      ok: false,
      reason: "already_running",
      message: "A backup is already running for this app.",
      runningBackupId: running.id
    };
  }

  const record = await (db as any).siteBackup.create({
    data: {
      siteId: input.site.id,
      resourceUuid,
      label: input.label,
      trigger: input.trigger,
      status: "running"
    }
  });

  // Keep the job detached but preserve its output for diagnosis.
  const jobLog = openJobLog("site-backup");

  const child = spawn(
    process.execPath,
    [
      scriptPath,
      "--resource-uuid", resourceUuid,
      "--backup-id", record.id,
      // Readable identifiers so Backblaze snapshots show the site, not just UUIDs.
      "--site-slug", input.site.slug?.trim() || input.site.id,
      "--site-name", input.site.name?.trim() || input.site.id,
      ...(input.label ? ["--label", input.label] : [])
    ],
    { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", jobLog, jobLog] }
  );
  child.unref();

  // Awaited rather than fired and forgotten: on a serverless-style runtime work
  // left running after the response is not guaranteed to finish. notifyBackupEvent
  // swallows its own errors, so this cannot fail the backup it is reporting.
  const { notifyBackupEvent } = await import("@/lib/site-notify");
  await notifyBackupEvent({
    siteId: input.site.id,
    event: "backup_started",
    trigger: input.trigger
  });

  return {
    ok: true,
    backupId: record.id,
    message: "Backup started — files and database are being captured to Backblaze. It will appear in the list shortly."
  };
}
