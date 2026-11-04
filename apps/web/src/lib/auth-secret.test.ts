import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_PLACEHOLDER_AUTH_SECRET, isDevAuthBypassEnabled, resolveAuthSecret } from "./auth-secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

function setEnv(nodeEnv: string, secret: string | undefined) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("NEXTAUTH_SECRET", secret as string);
}

describe("auth secret in production", () => {
  it.each([undefined, "", "   ", DEV_PLACEHOLDER_AUTH_SECRET])("fails closed for %j", (secret) => {
    setEnv("production", secret);
    expect(resolveAuthSecret()).toBeNull();
    expect(isDevAuthBypassEnabled()).toBe(false);
  });

  it("uses a real configured secret", () => {
    setEnv("production", "a-real-secret-value");
    expect(resolveAuthSecret()).toBe("a-real-secret-value");
    expect(isDevAuthBypassEnabled()).toBe(false);
  });
});

describe("auth secret in development", () => {
  it("falls back to the placeholder and allows the dev bypass when unset", () => {
    setEnv("development", undefined);
    expect(resolveAuthSecret()).toBe(DEV_PLACEHOLDER_AUTH_SECRET);
    expect(isDevAuthBypassEnabled()).toBe(true);
  });

  it("requires sign-in once a real secret is set", () => {
    setEnv("development", "local-secret");
    expect(resolveAuthSecret()).toBe("local-secret");
    expect(isDevAuthBypassEnabled()).toBe(false);
  });
});
