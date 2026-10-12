import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { MinIntervalGate } from "@/lib/rate-gate";
import { canRunRemedy, isRemedyAction, remedyCooldownMs, remedyGateKey, SITE_REMEDY_ACTIONS, type RemedyAction } from "@/lib/remedies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

/**
 * One cooldown per (site, action, target). In memory: jongo.app runs one
 * container, and a restart only resets the cooldowns, never the actions.
 */
const gates = new Map<string, MinIntervalGate>();

function gateFor(key: string, action: RemedyAction): MinIntervalGate {
  let gate = gates.get(key);
  if (!gate) {
    gate = new MinIntervalGate(remedyCooldownMs(action), 0);
    gates.set(key, gate);
  }
  return gate;
}

/**
 * POST { action, target? }: run an in-app fix for this site (restart, apply
 * the address, retry staging cleanup or setup, retry delete). Replaces every
 * "do this in Coolify" instruction.
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });

  const { siteId } = await params;
  const body: any = await req.clone().json().catch(() => null);
  const action = body?.action;
  const target = body?.target === "staging" ? "staging" : body?.target === "production" ? "production" : undefined;
  if (!isRemedyAction(action) || !(SITE_REMEDY_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  }

  const { getSiteWorkspace } = await import("@/lib/repositories");
  const { resolveSitePermissionSnapshot } = await import("@/lib/permissions");
  const viewer = { userId: session.user.id, email: session.user.email };
  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace || !/^[0-9a-f-]{36}$/i.test(workspace.id)) {
    return NextResponse.json({ ok: false, message: "Not found." }, { status: 404 });
  }
  const permissions = await resolveSitePermissionSnapshot({ siteId, workspace, viewer });
  const allowed = canRunRemedy(action, permissions);
  if (!allowed.ok) return NextResponse.json({ ok: false, message: allowed.message }, { status: 403 });

  const { db } = await import("@/lib/db");
  const site = await (db as any).site.findUnique({
    where: { id: workspace.id },
    select: {
      id: true,
      organizationId: true,
      coolifyServiceUuid: true,
      stagingTargetUuid: true,
      temporaryDomainSlug: true,
      temporaryDomainSuffix: true
    }
  });
  if (!site) return NextResponse.json({ ok: false, message: "Not found." }, { status: 404 });

  const admission = await gateFor(remedyGateKey(site.id, action, target), action).acquire();
  if (!admission.admitted) {
    const seconds = Math.max(1, Math.ceil(admission.retryAfterMs / 1000));
    return NextResponse.json({ ok: false, message: `Just tried that. Try again in ${seconds} s.` }, { status: 429 });
  }

  const { runSiteRemedy } = await import("@/lib/remedy-runner");
  const outcome = await runSiteRemedy({ req, routeSiteId: siteId, site, action, target }).catch((error) => {
    console.error(`[remedies] ${action} failed for ${site.id}`, error);
    return { ok: false, status: 500, message: "That didn't work just now. Try again in a minute.", remedy: null };
  });

  try {
    await (db as any).auditLog.create({
      data: {
        organizationId: site.organizationId,
        actorId: session.user.id,
        action: "site_updated",
        resourceType: "site",
        resourceId: site.id,
        details: { actionType: `remedy_${action}`, target: target ?? null, ok: outcome.ok, message: outcome.message },
        ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
        userAgent: req.headers.get("user-agent") ?? undefined
      }
    });
  } catch (error) {
    console.error("[remedies] audit write failed", error);
  }

  return NextResponse.json({ ok: outcome.ok, message: outcome.message, remedy: outcome.remedy ?? null }, { status: outcome.ok ? 200 : outcome.status });
}
