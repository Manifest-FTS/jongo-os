import { randomBytes } from "crypto";
import { hashSync } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ session: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }));
vi.mock("next-auth/next", () => ({ getServerSession: m.session }));
vi.mock("./auth-rate-limit", () => ({
  AUTH_RATE_LIMITS: { loginPerEmail: {}, loginPerIp: {} },
  clientIp: () => "203.0.113.1",
  hitRateLimits: async () => ({ allowed: true, retryAfterSeconds: 0 })
}));
vi.mock("./db", () => {
  const db = { user: { findFirst: m.findFirst, findUnique: m.findUnique, updateMany: m.updateMany } };
  return { db, getDb: async () => db };
});

import { auth, authConfig } from "./auth.config";
import { encryptSecret } from "./secret-box";
import { base32Encode, totpCodeAt, totpStep } from "./totp";

const authorize = (authConfig.providers[0] as any).options.authorize as (c: any, r: any) => Promise<any>;
const passwordHash = hashSync("correct horse", 4);
let user: Record<string, any>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("DEV_AUTH_EMAIL", "");
  user = {
    id: "u1",
    email: "owner@example.test",
    fullName: "Owner",
    passwordHash,
    deletedAt: null,
    sessionVersion: 3,
    totpSecret: null,
    totpEnabledAt: null,
    totpLastStep: null,
    totpRecoveryCodes: []
  };
  m.findFirst.mockImplementation(async () => user);
  m.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("sign-in with two-step sign-in", () => {
  it("signs in with just a password when it's off, carrying the session version", async () => {
    const result = await authorize({ email: user.email, password: "correct horse" }, {});
    expect(result).toMatchObject({ id: "u1", sv: 3 });
  });

  it("asks for a code after a correct password, and only then", async () => {
    const secret = base32Encode(randomBytes(20));
    user = { ...user, totpSecret: encryptSecret(secret), totpEnabledAt: new Date() };
    await expect(authorize({ email: user.email, password: "correct horse" }, {})).rejects.toThrow("AUTH_TOTP_REQUIRED");
    expect(await authorize({ email: user.email, password: "wrong" }, {})).toBeNull();
    await expect(authorize({ email: user.email, password: "correct horse", code: "000000" }, {})).rejects.toThrow("AUTH_TOTP_INVALID");
    const ok = await authorize({ email: user.email, password: "correct horse", code: totpCodeAt(secret, totpStep()) }, {});
    expect(ok).toMatchObject({ id: "u1" });
  });

  it("refuses a code another request already used", async () => {
    const secret = base32Encode(randomBytes(20));
    user = { ...user, totpSecret: encryptSecret(secret), totpEnabledAt: new Date() };
    m.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      authorize({ email: user.email, password: "correct horse", code: totpCodeAt(secret, totpStep()) }, {})
    ).rejects.toThrow("AUTH_TOTP_INVALID");
  });
});

describe("sign out everywhere", () => {
  it("ends a session issued before the version was raised", async () => {
    m.findUnique.mockResolvedValue({ id: "u1", email: "owner@example.test", fullName: "Owner", deletedAt: null, sessionVersion: 4 });
    m.session.mockResolvedValue({ user: { id: "u1", email: "owner@example.test" }, sv: 3 });
    expect(await auth()).toBeNull();
    m.session.mockResolvedValue({ user: { id: "u1", email: "owner@example.test" }, sv: 4 });
    expect(await auth()).toMatchObject({ user: { id: "u1" } });
  });

  it("keeps sessions from before the field existed until the first sign-out-everywhere", async () => {
    m.session.mockResolvedValue({ user: { id: "u1", email: "owner@example.test" } });
    m.findUnique.mockResolvedValue({ id: "u1", email: "owner@example.test", fullName: null, deletedAt: null, sessionVersion: 0 });
    expect(await auth()).toMatchObject({ user: { id: "u1" } });
    m.findUnique.mockResolvedValue({ id: "u1", email: "owner@example.test", fullName: null, deletedAt: null, sessionVersion: 1 });
    expect(await auth()).toBeNull();
  });
});
