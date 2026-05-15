import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { triggerCoolifyDeploy } from "@/lib/coolify";

export async function POST(req: NextRequest) {
  // Auth check (skipped in no-auth dev mode)
  const secret = process.env.NEXTAUTH_SECRET;
  let triggeredById: string | null = null;

  if (secret && secret !== "dev-secret-change-in-production") {
    const token = await getToken({ req, secret });
    if (!token?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    triggeredById = token.id as string;
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

  // Record deployment to DB and write audit log
  try {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    if (db) {
      // Resolve the Site by its Coolify service UUID, then find/create the Environment
      const site = await db.site.findFirst({
        where: {
          deletedAt: null,
          OR: [
            { coolifyServiceUuid: targetUuid },
            { coolifyServiceId: targetUuid }
          ]
        },
        select: { id: true }
      });

      let environmentId: string | null = null;

      if (site) {
        // Find or create the environment record for this site + deploy target
        const existingEnv = await db.environment.findFirst({
          where: { siteId: site.id, name: env },
          select: { id: true }
        });

        if (existingEnv) {
          environmentId = existingEnv.id;
        } else {
          const newEnv = await db.environment.create({
            data: {
              siteId: site.id,
              name: env,
              isProductionLike: env === "production"
            },
            select: { id: true }
          });
          environmentId = newEnv.id;
        }
      }

      if (environmentId) {
        await db.deployment.create({
          data: {
            environmentId,
            coolifyDeploymentId: result.deploymentId ?? null,
            status: "in_progress",
            triggeredAt: new Date(),
            ...(triggeredById ? { triggeredById } : {})
          }
        });
      }

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
    // DB write failure is non-fatal — deploy was already triggered
  }

  return NextResponse.json(result);
}
