import { createHash, randomBytes } from "node:crypto";
import { AUTH_CODE_TTL_SECONDS } from "./config";
import { verifyPkceS256 } from "./pkce";

type AuthCodeRow = {
  id: string;
  oidcClientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  scope: string;
  authTime: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

/** The slice of the Prisma client this module needs (kept structural so tests can supply a fake). */
export type AuthCodeStore = {
  oidcAuthCode: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findUnique(args: { where: { codeHash: string } }): Promise<AuthCodeRow | null>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
};

const CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Only this hash is stored; the code itself exists only in the redirect to the client. */
export function hashAuthCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function generateAuthCode(): string {
  return randomBytes(32).toString("base64url");
}

export type IssueAuthCodeInput = {
  oidcClientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  scope: string;
  authTime: Date;
  now?: Date;
};

export async function issueAuthCode(db: AuthCodeStore, input: IssueAuthCodeInput): Promise<{ code: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const code = generateAuthCode();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000);
  await db.oidcAuthCode.create({
    data: {
      codeHash: hashAuthCode(code),
      oidcClientId: input.oidcClientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      nonce: input.nonce,
      scope: input.scope,
      authTime: input.authTime,
      expiresAt,
      createdAt: now
    }
  });
  // Opportunistic cleanup, no scheduler: codes are useless an hour after expiry.
  await db.oidcAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 3600_000) } } }).catch(() => undefined);
  return { code, expiresAt };
}

export type RedeemFailure = "unknown" | "replay" | "expired" | "client_mismatch" | "redirect_mismatch" | "pkce_failed";
export type RedeemResult =
  | { ok: true; userId: string; scope: string; nonce: string; authTime: Date }
  | { ok: false; reason: RedeemFailure; userId?: string };

export type RedeemAuthCodeInput = {
  code: string;
  oidcClientId: string;
  redirectUri: string;
  codeVerifier: string;
  now?: Date;
};

/**
 * Single use by one atomic compare-and-set (consumedAt IS NULL AND not expired). Once a code is
 * found and consumed it stays consumed whatever the later checks say, so a stolen code cannot be
 * retried with different parameters.
 */
export async function redeemAuthCode(db: AuthCodeStore, input: RedeemAuthCodeInput): Promise<RedeemResult> {
  const now = input.now ?? new Date();
  if (!CODE_SHAPE.test(input.code)) return { ok: false, reason: "unknown" };
  const codeHash = hashAuthCode(input.code);

  const row = await db.oidcAuthCode.findUnique({ where: { codeHash } });
  if (!row) return { ok: false, reason: "unknown" };

  const claimed = await db.oidcAuthCode.updateMany({
    where: { codeHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now }
  });
  if (claimed.count !== 1) {
    // Re-read: a concurrent winner may have consumed it after our first read.
    const fresh = (await db.oidcAuthCode.findUnique({ where: { codeHash } })) ?? row;
    const expired = fresh.consumedAt === null && fresh.expiresAt.getTime() <= now.getTime();
    return { ok: false, reason: expired ? "expired" : "replay", userId: row.userId };
  }

  if (row.oidcClientId !== input.oidcClientId) return { ok: false, reason: "client_mismatch", userId: row.userId };
  if (row.redirectUri !== input.redirectUri) return { ok: false, reason: "redirect_mismatch", userId: row.userId };
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) return { ok: false, reason: "pkce_failed", userId: row.userId };
  return { ok: true, userId: row.userId, scope: row.scope, nonce: row.nonce, authTime: row.authTime };
}
