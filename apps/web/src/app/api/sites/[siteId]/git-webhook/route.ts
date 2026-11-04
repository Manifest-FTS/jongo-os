import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { resolveSiteAccess } from "@/lib/tenant-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

async function load(siteId: string) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { response: NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 }) };
  const access = await resolveSiteAccess(siteId, userId);
  if (!access) return { response: NextResponse.json({ ok: false, message: "App not found." }, { status: 404 }) };
  const { db } = await import("@/lib/db");
  const site = await db.site.findUnique({
    where: { id: access.site.id },
    select: { id: true, organizationId: true, gitDeployKeyId: true, gitWebhookSecretEnc: true, gitProvider: true }
  });
  if (!site?.gitDeployKeyId) return { response: NextResponse.json({ ok: false, message: "This app isn't deployed with a deploy key." }, { status: 404 }) };
  return { site, userId, isAdmin: access.isAdmin || access.isPlatformAdmin, db };
}

/** GET: the webhook address for push deploys (the secret is never shown again). */
export async function GET(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const loaded = await load(siteId);
  if ("response" in loaded) return loaded.response;
  const { gitWebhookUrl } = await import("@/lib/git-webhooks");
  return NextResponse.json({ ok: true, url: gitWebhookUrl(loaded.site.id), hasSecret: Boolean(loaded.site.gitWebhookSecretEnc), provider: loaded.site.gitProvider });
}

/** POST: make a new secret (admins). The old one stops working at once. */
export async function POST(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const loaded = await load(siteId);
  if ("response" in loaded) return loaded.response;
  if (!loaded.isAdmin) return NextResponse.json({ ok: false, message: "Only the client's admins can change the webhook secret." }, { status: 403 });
  const { randomBytes } = await import("node:crypto");
  const { encryptSecret } = await import("@/lib/secret-box");
  const secret = randomBytes(24).toString("hex");
  try {
    await loaded.db.site.update({ where: { id: loaded.site.id }, data: { gitWebhookSecretEnc: encryptSecret(secret) } });
  } catch {
    return NextResponse.json({ ok: false, message: "The secret couldn't be changed right now. Try again shortly." }, { status: 503 });
  }
  const { audit } = await import("@/lib/github-installations");
  await audit(loaded.site.organizationId, loaded.userId, "git_webhook_secret_rotated", {}, loaded.site.id);
  const { gitWebhookUrl } = await import("@/lib/git-webhooks");
  return NextResponse.json({ ok: true, url: gitWebhookUrl(loaded.site.id), secret });
}
