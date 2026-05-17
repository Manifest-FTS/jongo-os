import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

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

function getInviteSecret(): string {
  return process.env.INVITE_TOKEN_SECRET?.trim() || process.env.NEXTAUTH_SECRET || "dev-invite-token-secret";
}

export function createInviteTokenForInvitation(invitationId: string): string {
  const signature = createHmac("sha256", getInviteSecret()).update(invitationId).digest("base64url");
  return `v2.${invitationId}.${signature}`;
}

export function parseInvitationIdFromToken(token: string): string | null {
  const match = token.match(/^v2\.([0-9a-fA-F-]{36})\.([A-Za-z0-9_-]+)$/);
  if (!match) {
    return null;
  }

  const invitationId = match[1];
  const providedSignature = match[2];
  const expectedSignature = createHmac("sha256", getInviteSecret()).update(invitationId).digest("base64url");

  if (providedSignature.length !== expectedSignature.length) {
    return null;
  }

  const isValid = timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));
  return isValid ? invitationId : null;
}

export function hashInviteToken(token: string): string {
  const pepper = getInviteSecret();
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

export function buildInviteUrlForInvitation(invitationId: string): string {
  return buildInviteUrl(createInviteTokenForInvitation(invitationId));
}
