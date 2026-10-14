import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `state` carried through GitHub's install page: which organization and
 * user started "Connect GitHub". Signed so nobody can attach an install to an
 * organization they don't administer; expires after 10 minutes.
 */
export const INSTALL_STATE_TTL_MS = 10 * 60_000;

export type InstallStatePayload = { orgId: string; userId: string; sourceId?: string };

function mac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signInstallState(payload: InstallStatePayload, secret: string, now: number = Date.now()): string {
  const data = Buffer.from(
    JSON.stringify({ o: payload.orgId, u: payload.userId, ...(payload.sourceId ? { s: payload.sourceId } : {}), e: now + INSTALL_STATE_TTL_MS })
  ).toString("base64url");
  return `${data}.${mac(data, secret)}`;
}

export function verifyInstallState(
  token: string | null | undefined,
  secret: string,
  now: number = Date.now()
): { ok: true; payload: InstallStatePayload } | { ok: false; reason: "expired" | "bad_signature" | "malformed" } {
  const parts = (token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [data, signature] = parts;
  const expected = Buffer.from(mac(data, secret));
  const provided = Buffer.from(signature);
  if (!secret || expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: "bad_signature" };
  let parsed: { o?: unknown; u?: unknown; s?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed.o !== "string" || typeof parsed.u !== "string" || typeof parsed.e !== "number") return { ok: false, reason: "malformed" };
  if (now > parsed.e) return { ok: false, reason: "expired" };
  return { ok: true, payload: { orgId: parsed.o, userId: parsed.u, ...(typeof parsed.s === "string" ? { sourceId: parsed.s } : {}) } };
}
