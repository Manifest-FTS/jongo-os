import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { triggerCoolifyDeploy } from "@/lib/coolify";

export async function POST(req: NextRequest) {
  // Auth check (skipped in no-auth dev mode)
  const secret = process.env.NEXTAUTH_SECRET;
  if (secret && secret !== "dev-secret-change-in-production") {
    const token = await getToken({ req, secret });
    if (!token?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { serviceUuid?: string; siteId?: string; environment?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { serviceUuid, siteId, environment } = body;

  if (!serviceUuid && !siteId) {
    return NextResponse.json({ error: "Provide serviceUuid or siteId" }, { status: 400 });
  }

  const env = environment === "staging" ? "staging" : "production";
  const targetUuid = serviceUuid ?? siteId ?? "";

  let result;
  try {
    result = await triggerCoolifyDeploy(targetUuid, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deploy trigger failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Write audit log if DB is available (lazy import, no-op if Prisma not generated)
  try {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    if (db) {
      await db.auditLog.create({
        data: {
          action: "deploy_triggered",
          resourceType: "deployment",
          resourceId: result.deploymentId,
          metadata: JSON.stringify({ serviceUuid: targetUuid, environment: env, mode: result.mode }),
          ipAddress: req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown"
        }
      });
    }
  } catch {
    // Audit log write failure is non-fatal
  }

  return NextResponse.json(result);
}
