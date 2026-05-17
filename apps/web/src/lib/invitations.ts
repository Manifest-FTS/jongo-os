import { createHash, randomBytes } from "crypto";

const INVITE_TTL_DAYS = Number.parseInt(process.env.INVITE_TTL_DAYS ?? "7", 10);

export function getInviteExpiryDate(now = new Date()): Date {
  const ttlDays = Number.isFinite(INVITE_TTL_DAYS) && INVITE_TTL_DAYS > 0 ? INVITE_TTL_DAYS : 7;
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + ttlDays);
  return expiresAt;
}

export function createInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  const pepper = process.env.INVITE_TOKEN_SECRET?.trim() || process.env.NEXTAUTH_SECRET || "dev-invite-token-secret";
  return createHash("sha256").update(`${pepper}:${token}`).digest("hex");
}

export function isInviteExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function getInviteBaseUrl(): string {
  const explicit = process.env.INVITE_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  const nextAuth = process.env.NEXTAUTH_URL?.trim();
  if (nextAuth) {
    return nextAuth.replace(/\/$/, "");
  }

  return "http://localhost:3000";
}

export function buildInviteUrl(token: string): string {
  return `${getInviteBaseUrl()}/auth/invite/${encodeURIComponent(token)}`;
}
