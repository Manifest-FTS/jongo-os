import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

// Mirrors the auth of /api/ops/backup-reconcile: a shared ops token OR a
// bootstrap-admin session.
function isAuthorized(session: Awaited<ReturnType<typeof auth>>, request: Request): boolean {
  const opsToken = process.env.BACKUP_RECONCILE_TOKEN?.trim() || process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const providedToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const tokenAuthorized = Boolean(opsToken && providedToken && providedToken === opsToken);

  const bootstrapAdmin = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const sessionEmail = normalizeEmail(session?.user?.email);
  const adminSession = Boolean(session?.user?.id && bootstrapAdmin && sessionEmail === bootstrapAdmin);

  return tokenAuthorized || adminSession;
}

type VerificationPayload = {
  resourceUuid?: unknown;
  result?: unknown;
  verifiedAt?: unknown;
  rpoHours?: unknown;
  restoreSeconds?: unknown;
  offsitePresent?: unknown;
  rowsMatch?: unknown;
  rows?: unknown;
  detail?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// Record the outcome of an end-to-end restore test. Called by
// scripts/verify-jongo-backup.mjs after a --restore-test run.
export async function POST(request: Request) {
  const session = await auth();
  if (!isAuthorized(session, request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: VerificationPayload;
  try {
    body = (await request.json()) as VerificationPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const resourceUuid = asString(body.resourceUuid);
  const result = asString(body.result);
  if (!resourceUuid) {
    return NextResponse.json({ error: "resourceUuid is required." }, { status: 400 });
  }
  if (result !== "pass" && result !== "fail") {
    return NextResponse.json({ error: "result must be 'pass' or 'fail'." }, { status: 400 });
  }

  const verifiedAtRaw = asString(body.verifiedAt);
  const verifiedAt = verifiedAtRaw && !Number.isNaN(Date.parse(verifiedAtRaw))
    ? new Date(verifiedAtRaw)
    : new Date();

  const data = {
    lastResult: result,
    lastVerifiedAt: verifiedAt,
    rpoHours: asInt(body.rpoHours) ?? 26,
    restoreSeconds: asInt(body.restoreSeconds) ?? null,
    offsitePresent: asString(body.offsitePresent) ?? null,
    rowsMatch: typeof body.rowsMatch === "boolean" ? body.rowsMatch : null,
    rows: body.rows && typeof body.rows === "object" ? (body.rows as object) : undefined,
    detail: asString(body.detail) ?? null
  };

  try {
    const { db } = await import("@/lib/db");
    const record = await db.backupRestoreVerification.upsert({
      where: { resourceUuid },
      create: { resourceUuid, ...data },
      update: data
    });

    return NextResponse.json({
      ok: true,
      resourceUuid: record.resourceUuid,
      lastResult: record.lastResult,
      lastVerifiedAt: record.lastVerifiedAt
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to record verification: ${error instanceof Error ? error.message : "unknown"}` },
      { status: 500 }
    );
  }
}
