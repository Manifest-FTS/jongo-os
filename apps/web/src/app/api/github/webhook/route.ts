import { after, NextResponse } from "next/server";
import { verifyGithubSignature } from "@/lib/github-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every event for the Jongo GitHub App lands here (Coolify's own GitHub webhook
 * can't tell installs of one shared app apart). Signature first, then dedupe
 * on the delivery id, then answer quickly and do the work after the response.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  // Each client has its own Jongo GitHub App; GitHub says which one sent this.
  const { getGithubApp } = await import("@/lib/github-app");
  const appId = Number(request.headers.get("x-github-hook-installation-target-id"));
  const app = await getGithubApp(Number.isFinite(appId) && appId > 0 ? { appId } : {}).catch(() => null);
  if (!app || !verifyGithubSignature(raw, request.headers.get("x-hub-signature-256"), app.webhookSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const event = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (event === "ping") return NextResponse.json({ ok: true, pong: true });

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  if (deliveryId) {
    const { getDb } = await import("@/lib/db");
    const db: any = await getDb();
    try {
      await db?.githubWebhookDelivery.create({ data: { deliveryId, event } });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") return NextResponse.json({ ok: true, duplicate: true });
      throw error;
    }
  }

  after(async () => {
    try {
      if (event === "push") {
        const { handlePush } = await import("@/lib/github-deploys");
        await handlePush(payload);
      } else if (event === "installation" || event === "installation_repositories" || event === "repository") {
        const { applyInstallEvent } = await import("@/lib/github-installations");
        await applyInstallEvent(event, payload);
      }
    } catch (error) {
      console.error(`[github] webhook ${event} ${deliveryId} failed`, error);
    }
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
