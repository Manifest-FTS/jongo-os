import { decryptSecret, encryptSecret } from "./secret-box";
import {
  formatSecretForDisplay,
  generateRecoveryCodes,
  generateTotpSecret,
  matchRecoveryCode,
  otpauthUri,
  verifyTotp
} from "./totp";

/**
 * Two-step sign-in storage. The secret is encrypted at rest, recovery codes are
 * hashed, and every accepted code is recorded with a conditional update so the
 * same code can't be used twice, even by two requests at once.
 */

/** A setup that wasn't finished within this long has to start again. */
export const PENDING_SETUP_MINUTES = 15;

export type TwoFactorUser = {
  id: string;
  email: string;
  totpSecret: string | null;
  totpEnabledAt: Date | null;
  totpLastStep: number | null;
  totpPendingSecret?: string | null;
  totpPendingAt?: Date | null;
  totpRecoveryCodes: string[] | null;
};

export const TWO_FACTOR_SELECT = {
  id: true,
  email: true,
  passwordHash: true,
  authProvider: true,
  sessionVersion: true,
  totpSecret: true,
  totpEnabledAt: true,
  totpLastStep: true,
  totpPendingSecret: true,
  totpPendingAt: true,
  totpRecoveryCodes: true
} as const;

export function isTwoFactorEnabled(user: Pick<TwoFactorUser, "totpSecret" | "totpEnabledAt"> | null | undefined): boolean {
  return Boolean(user?.totpEnabledAt && user.totpSecret);
}

export type SecondFactorResult =
  | { ok: true; method: "code" | "recovery"; recoveryCodesLeft: number }
  | { ok: false };

/**
 * Accept a current authenticator code or an unused recovery code. Either is
 * spent on success.
 */
export async function spendSecondFactor(db: any, user: TwoFactorUser, input: unknown): Promise<SecondFactorResult> {
  if (!isTwoFactorEnabled(user)) return { ok: false };
  const hashes = user.totpRecoveryCodes ?? [];

  const recoveryHash = matchRecoveryCode(hashes, input);
  if (recoveryHash) {
    const remaining = hashes.filter((hash) => hash !== recoveryHash);
    const result = await db.user.updateMany({
      where: { id: user.id, totpRecoveryCodes: { has: recoveryHash } },
      data: { totpRecoveryCodes: remaining }
    });
    return result.count === 1 ? { ok: true, method: "recovery", recoveryCodesLeft: remaining.length } : { ok: false };
  }

  let secret: string;
  try {
    secret = decryptSecret(String(user.totpSecret));
  } catch (error) {
    console.error("[two-factor] stored secret can't be read", error);
    return { ok: false };
  }
  const step = verifyTotp(secret, input, { lastStep: user.totpLastStep });
  if (step === null) return { ok: false };
  const result = await db.user.updateMany({
    where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step }
  });
  return result.count === 1 ? { ok: true, method: "code", recoveryCodesLeft: hashes.length } : { ok: false };
}

/** Begin setup: a fresh secret, saved as pending until a code confirms it. */
export async function startTwoFactorSetup(db: any, user: TwoFactorUser, now = new Date()) {
  const secret = generateTotpSecret();
  await db.user.update({
    where: { id: user.id },
    data: { totpPendingSecret: encryptSecret(secret), totpPendingAt: now }
  });
  const uri = otpauthUri(user.email, secret);
  return { secret: formatSecretForDisplay(secret), uri };
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: "no_setup" | "expired" | "invalid_code" };

/** Finish setup with the first code from the app; returns recovery codes once. */
export async function confirmTwoFactorSetup(db: any, user: TwoFactorUser, input: unknown, now = new Date()): Promise<ConfirmResult> {
  if (!user.totpPendingSecret || !user.totpPendingAt) return { ok: false, reason: "no_setup" };
  if (now.getTime() - new Date(user.totpPendingAt).getTime() > PENDING_SETUP_MINUTES * 60_000) {
    return { ok: false, reason: "expired" };
  }
  let secret: string;
  try {
    secret = decryptSecret(user.totpPendingSecret);
  } catch {
    return { ok: false, reason: "no_setup" };
  }
  const step = verifyTotp(secret, input, { now });
  if (step === null) return { ok: false, reason: "invalid_code" };

  const { codes, hashes } = generateRecoveryCodes();
  const result = await db.user.updateMany({
    where: { id: user.id, totpPendingSecret: user.totpPendingSecret },
    data: {
      totpSecret: user.totpPendingSecret,
      totpEnabledAt: now,
      totpLastStep: step,
      totpPendingSecret: null,
      totpPendingAt: null,
      totpRecoveryCodes: hashes
    }
  });
  if (result.count !== 1) return { ok: false, reason: "no_setup" };
  return { ok: true, recoveryCodes: codes };
}

export async function disableTwoFactor(db: any, userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: {
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      totpPendingSecret: null,
      totpPendingAt: null,
      totpRecoveryCodes: []
    }
  });
}

export async function replaceRecoveryCodes(db: any, userId: string): Promise<string[]> {
  const { codes, hashes } = generateRecoveryCodes();
  await db.user.update({ where: { id: userId }, data: { totpRecoveryCodes: hashes } });
  return codes;
}

/** Sign the account out on every device, this one included. */
export async function signOutEverywhere(db: any, userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}
