import { randomBytes } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  matchRecoveryCode,
  otpauthUri,
  totpCodeAt,
  totpStep,
  verifyTotp
} from "./totp";
import { qrSvg } from "./totp-qr";
import { confirmTwoFactorSetup, spendSecondFactor, startTwoFactorSetup } from "./two-factor";
import { decryptSecret, encryptSecret } from "./secret-box";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890", last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const at = (seconds: number) => new Date(seconds * 1000);

describe("totp", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"]
  ])("matches the RFC 6238 vector at %i", (seconds, code) => {
    expect(totpCodeAt(RFC_SECRET, totpStep(at(seconds)))).toBe(code);
  });

  it("round-trips base32", () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Decode("gezd gnbv-gy3t qojq")).toEqual(base32Decode("GEZDGNBVGY3TQOJQ"));
  });

  it("accepts one step of clock drift either way, not two", () => {
    const now = at(1_700_000_000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 1), { now })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step + 1), { now })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 2), { now })).toBeNull();
  });

  it("refuses a code already used, and older ones", () => {
    const now = at(1_700_000_000);
    const step = totpStep(now);
    const code = totpCodeAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, { now, lastStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 1), { now, lastStep: step - 1 })).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { now, lastStep: step - 1 })).toBe(step);
  });

  it("ignores spaces and rejects junk", () => {
    const now = at(1_700_000_000);
    const code = totpCodeAt(RFC_SECRET, totpStep(now));
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", { now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", { now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, undefined, { now })).toBeNull();
  });

  it("builds an otpauth link apps can read", () => {
    const uri = otpauthUri("a+b@example.test", "JBSWY3DPEHPK3PXP");
    expect(uri).toMatch(/^otpauth:\/\/totp\/Jongo%3Aa%2Bb%40example\.test\?/);
    expect(new URL(uri).searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(new URL(uri).searchParams.get("issuer")).toBe("Jongo");
  });

  it("draws a QR code as SVG", () => {
    const svg = qrSvg(otpauthUri("someone@example.test", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path");
    expect(svg).not.toContain("someone@example.test");
  });
});

describe("recovery codes", () => {
  it("makes ten distinct codes and matches them loosely", () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(hashes.join()).not.toContain(codes[0]);
    expect(matchRecoveryCode(hashes, codes[3].toUpperCase().replace("-", " "))).toBe(hashes[3]);
    expect(matchRecoveryCode(hashes, "aaaaa-aaaaa")).toBeNull();
    expect(matchRecoveryCode(hashes, "123456")).toBeNull();
  });
});

describe("two-factor storage", () => {
  let row: Record<string, any>;
  const db = {
    user: {
      update: vi.fn(async ({ data }: any) => (row = { ...row, ...data })),
      // Minimal model of the conditional updates two-factor.ts relies on.
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.totpRecoveryCodes?.has && !row.totpRecoveryCodes.includes(where.totpRecoveryCodes.has)) return { count: 0 };
        if (where.OR) {
          const lt = where.OR[1].totpLastStep.lt;
          if (!(row.totpLastStep === null || row.totpLastStep < lt)) return { count: 0 };
        }
        if ("totpPendingSecret" in where && where.totpPendingSecret !== row.totpPendingSecret) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      })
    }
  };

  beforeEach(() => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    row = {
      id: "u1",
      email: "owner@example.test",
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      totpPendingSecret: null,
      totpPendingAt: null,
      totpRecoveryCodes: []
    };
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sets up, turns on with the first code, and stores only ciphertext and hashes", async () => {
    const setup = await startTwoFactorSetup(db, row as any);
    const secret = setup.secret.replace(/\s/g, "");
    expect(row.totpPendingSecret).toMatch(/^v2:/);
    expect(decryptSecret(row.totpPendingSecret)).toBe(secret);

    const wrong = await confirmTwoFactorSetup(db, row as any, "000000");
    expect(wrong.ok ? "" : wrong.reason).toMatch(/invalid_code/);

    const result = await confirmTwoFactorSetup(db, row as any, totpCodeAt(secret, totpStep()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveryCodes).toHaveLength(10);
    expect(row.totpEnabledAt).toBeInstanceOf(Date);
    expect(row.totpSecret).toMatch(/^v2:/);
    expect(row.totpPendingSecret).toBeNull();
    expect(row.totpRecoveryCodes.join()).not.toContain(result.recoveryCodes[0]);
  });

  it("refuses a setup that sat too long", async () => {
    await startTwoFactorSetup(db, row as any, new Date(Date.now() - 16 * 60_000));
    const secret = decryptSecret(row.totpPendingSecret);
    const result = await confirmTwoFactorSetup(db, row as any, totpCodeAt(secret, totpStep()));
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("spends a sign-in code once", async () => {
    const secret = base32Encode(randomBytes(20));
    row = { ...row, totpSecret: encryptSecret(secret), totpEnabledAt: new Date(), totpRecoveryCodes: [] };
    const code = totpCodeAt(secret, totpStep());
    expect((await spendSecondFactor(db, row as any, code)).ok).toBe(true);
    expect((await spendSecondFactor(db, row as any, code)).ok).toBe(false);
  });

  it("spends a recovery code once", async () => {
    const { codes, hashes } = generateRecoveryCodes();
    row = { ...row, totpSecret: encryptSecret(base32Encode(randomBytes(20))), totpEnabledAt: new Date(), totpRecoveryCodes: hashes };
    const first = await spendSecondFactor(db, row as any, codes[0]);
    expect(first).toEqual({ ok: true, method: "recovery", recoveryCodesLeft: 9 });
    expect((await spendSecondFactor(db, row as any, codes[0])).ok).toBe(false);
  });

  it("refuses everything when two-step sign-in is off", async () => {
    expect((await spendSecondFactor(db, row as any, "123456")).ok).toBe(false);
  });
});
