import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;

/**
 * POST /api/webhooks/git/{siteId} — push events for an app read with a deploy
 * key, from GitLab, Bitbucket, Gitea/Forgejo/Codeberg, GitHub or a
 * self-hosted server. Verified with the app's own secret (lib/git-webhooks.ts);
 * a push to the app's branch deploys it. Unknown apps and bad signatures get
 * the same answer, so the endpoint reveals nothing.
 */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const denied = () => NextResponse.json({ ok: false }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) return denied();

  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY) return NextResponse.json({ ok: false }, { status: 400 });

  const { db } = await import("@/lib/db");
  const site = await db.site.findFirst({
    where: { id: siteId, deletedAt: null },
    select: { id: true, organizationId: true, coolifyServiceUuid: true, gitBranch: true, autoDeploy: true, gitWebhookSecretEnc: true }
  });
  if (!site?.gitWebhookSecretEnc || !site.coolifyServiceUuid) return denied();

  const { decryptSecret } = await import("@/lib/secret-box");
  const { verifyGitWebhook, parseGitPush } = await import("@/lib/git-webhooks");
  let secret = "";
  try {
    secret = decryptSecret(site.gitWebhookSecretEnc);
  } catch {
    console.error("[git-webhook] secret could not be decrypted", { siteId });
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  if (!verifyGitWebhook(request.headers, raw, secret)) return denied();

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, message: "Send the webhook as JSON." }, { status: 400 });
  }
  const push = parseGitPush(request.headers, payload);
  if (push.kind === "ping") return NextResponse.json({ ok: true, message: "Connected." });
  if (push.kind === "ignored") return NextResponse.json({ ok: true, skipped: push.reason });
  if (site.gitBranch && push.branch !== site.gitBranch) {
    return NextResponse.json({ ok: true, skipped: `push to ${push.branch}, app deploys ${site.gitBranch}` });
  }

  const { audit } = await import("@/lib/github-installations");
  if (!site.autoDeploy) {
    await db.site.update({ where: { id: site.id }, data: { pendingCommitSha: push.sha, pendingCommitMessage: push.message } });
    await audit(site.organizationId, null, "git_commit_pending", { sha: push.sha, branch: push.branch }, site.id);
    return NextResponse.json({ ok: true, deployed: false, message: "Recorded; automatic deploys are off for this app." });
  }

  const { deployOnPush } = await import("@/lib/deploy-operation");
  const result = await deployOnPush({
    siteId: site.id,
    organizationId: site.organizationId,
    environment: "production",
    targetUuid: site.coolifyServiceUuid
  }).catch((error) => ({ ok: false, via: "operation" as const, message: error instanceof Error ? error.message : "failed" }));
  if (result.ok) {
    await db.site.update({ where: { id: site.id }, data: { lastDeployedSha: push.sha, pendingCommitSha: null, pendingCommitMessage: null } });
  }
  await audit(site.organizationId, null, result.ok ? "git_push_deploy" : "git_push_deploy_failed", { sha: push.sha, branch: push.branch, message: push.message }, site.id);
  return NextResponse.json({ ok: result.ok, deployed: result.ok }, { status: result.ok ? 202 : 503 });
}
