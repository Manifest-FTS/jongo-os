/**
 * Push webhooks from any Git host, for apps read with a deploy key.
 *
 * Each app has its own address (/api/webhooks/git/<app id>) and secret. The
 * client adds both to their repository's webhooks. Verification depends on
 * the host, detected from the headers it sends, so self-hosted GitLab, Gitea
 * and Forgejo work as well as the cloud ones:
 *
 *   GitLab           X-Gitlab-Token: <secret>
 *   GitHub           X-Hub-Signature-256: sha256=<hmac>
 *   Bitbucket Cloud  X-Hub-Signature: sha256=<hmac>
 *   Gitea / Forgejo  X-Gitea-Signature (or X-Forgejo-Signature): <hmac>
 *
 * The hosting address is never involved: pushes reach Jongo, and Jongo decides
 * what to deploy.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function gitWebhookUrl(siteId: string): string {
  const base = (process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || "").trim().replace(/\/+$/, "");
  return `${base}/api/webhooks/git/${siteId}`;
}

type HeaderSource = { get(name: string): string | null };

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** True when the request carries a valid signature or token for `secret`. */
export function verifyGitWebhook(headers: HeaderSource, rawBody: string, secret: string): boolean {
  if (!secret) return false;
  const gitlab = headers.get("x-gitlab-token");
  if (gitlab !== null) return equal(gitlab, secret);
  const expected = hmacHex(secret, rawBody);
  for (const name of ["x-hub-signature-256", "x-hub-signature"]) {
    const value = headers.get(name);
    if (value !== null) return value.startsWith("sha256=") && equal(value.slice(7).toLowerCase(), expected);
  }
  for (const name of ["x-gitea-signature", "x-forgejo-signature", "x-gogs-signature"]) {
    const value = headers.get(name);
    if (value !== null) return equal(value.toLowerCase(), expected);
  }
  return false;
}

export type ParsedPush =
  | { kind: "push"; branch: string; sha: string | null; message: string | null }
  | { kind: "ping" }
  | { kind: "ignored"; reason: string };

const ZERO_SHA = /^0+$/;

/** What a push event says, whichever host sent it. */
export function parseGitPush(headers: HeaderSource, payload: any): ParsedPush {
  const event = (
    headers.get("x-github-event") ??
    headers.get("x-gitlab-event") ??
    headers.get("x-event-key") ??
    headers.get("x-gitea-event") ??
    headers.get("x-forgejo-event") ??
    ""
  ).toLowerCase();
  if (event === "ping" || event === "diagnostics:ping") return { kind: "ping" };
  if (!payload || typeof payload !== "object") return { kind: "ignored", reason: "no payload" };

  // Bitbucket Cloud: push.changes[].new
  if (event === "repo:push" || payload.push?.changes) {
    const change = Array.isArray(payload.push?.changes) ? payload.push.changes.find((c: any) => c?.new?.type === "branch") : null;
    if (!change) return { kind: "ignored", reason: "no branch update" };
    return {
      kind: "push",
      branch: String(change.new.name ?? ""),
      sha: typeof change.new.target?.hash === "string" ? change.new.target.hash : null,
      message: typeof change.new.target?.message === "string" ? change.new.target.message.split("\n")[0].slice(0, 200) : null
    };
  }

  if (event && !["push", "push hook"].includes(event)) return { kind: "ignored", reason: `event ${event}` };
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  if (!ref.startsWith("refs/heads/")) return { kind: "ignored", reason: "not a branch" };
  const after = typeof payload.after === "string" ? payload.after : typeof payload.checkout_sha === "string" ? payload.checkout_sha : null;
  if (payload.deleted === true || (after && ZERO_SHA.test(after))) return { kind: "ignored", reason: "branch deleted" };
  const head = payload.head_commit ?? (Array.isArray(payload.commits) ? payload.commits[payload.commits.length - 1] : null);
  return {
    kind: "push",
    branch: ref.slice("refs/heads/".length),
    sha: after,
    message: typeof head?.message === "string" ? head.message.split("\n")[0].slice(0, 200) : null
  };
}
