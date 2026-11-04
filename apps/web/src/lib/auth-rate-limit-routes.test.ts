import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  hit: vi.fn(),
  userFind: vi.fn(),
  tokenCreate: vi.fn(),
  tokenExpire: vi.fn(),
  send: vi.fn()
}));

vi.mock("@/lib/auth-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-rate-limit")>()),
  hitRateLimit: m.hit
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: m.userFind },
    passwordResetToken: { create: m.tokenCreate, updateMany: m.tokenExpire, findUnique: vi.fn() }
  }
}));
vi.mock("@/lib/email", () => ({ sendPasswordResetEmail: m.send }));

import { POST as forgot } from "../app/api/auth/forgot-password/route";
import { POST as reset } from "../app/api/auth/reset-password/route";
import { AUTH_RATE_LIMITS } from "./auth-rate-limit";

const ALLOWED = { allowed: true, retryAfterSeconds: 0 };
const BLOCKED = { allowed: false, retryAfterSeconds: 300 };

function post(body: unknown) {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9" },
    body: JSON.stringify(body)
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.hit.mockResolvedValue(ALLOWED);
  m.userFind.mockResolvedValue({ id: "u1", email: "a@example.com", passwordHash: "x" });
  m.send.mockResolvedValue(undefined);
});

describe("forgot-password rate limits", () => {
  it("returns 429 when the address is over its limit", async () => {
    m.hit.mockImplementation(async (rule) => (rule === AUTH_RATE_LIMITS.forgotPerIp ? BLOCKED : ALLOWED));
    const res = await forgot(post({ email: "a@example.com" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(m.send).not.toHaveBeenCalled();
  });

  it("answers exactly like success but sends nothing when the email is over its limit", async () => {
    const normal = await (await forgot(post({ email: "a@example.com" }))).json();
    expect(m.send).toHaveBeenCalledTimes(1);

    m.send.mockClear();
    m.tokenCreate.mockClear();
    m.hit.mockImplementation(async (rule) => (rule === AUTH_RATE_LIMITS.forgotPerEmail ? BLOCKED : ALLOWED));
    const res = await forgot(post({ email: "a@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(normal);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.tokenCreate).not.toHaveBeenCalled();
  });

  it("counts the email and the client address", async () => {
    await forgot(post({ email: "a@example.com" }));
    expect(m.hit).toHaveBeenCalledWith(AUTH_RATE_LIMITS.forgotPerIp, "9.9.9.9");
    expect(m.hit).toHaveBeenCalledWith(AUTH_RATE_LIMITS.forgotPerEmail, "a@example.com");
  });
});

describe("reset-password rate limit", () => {
  it("refuses before looking at the token", async () => {
    m.hit.mockResolvedValue(BLOCKED);
    const res = await reset(post({ token: "t", password: "long-enough-password" }));
    expect(res.status).toBe(429);
  });
});
