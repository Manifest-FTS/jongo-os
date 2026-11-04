import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, keyId, needsReencryption, SecretKeyConfigError } from "./secret-box";
// @ts-expect-error — plain .mjs script without type declarations
import * as script from "../../../../scripts/reencrypt-secrets.mjs";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("hex");

function env(values: Record<string, string | undefined>) {
  vi.stubEnv("NODE_ENV", values.NODE_ENV ?? "production");
  for (const name of ["SECRETS_ENCRYPTION_KEY", "SECRETS_ENCRYPTION_KEY_PREVIOUS", "WORDPRESS_TELEMETRY_ENCRYPTION_SECRET", "NEXTAUTH_SECRET"]) {
    vi.stubEnv(name, (values[name] ?? "") as string);
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("secret-box v2", () => {
  it("round-trips with the dedicated key and tags the key id", () => {
    env({ SECRETS_ENCRYPTION_KEY: KEY_A });
    const sealed = encryptSecret("hunter2");
    expect(sealed.startsWith(`v2:${keyId(Buffer.from(KEY_A, "base64"))}:`)).toBe(true);
    expect(decryptSecret(sealed)).toBe("hunter2");
  });

  it("does not depend on NEXTAUTH_SECRET, so rotating it keeps secrets readable", () => {
    env({ SECRETS_ENCRYPTION_KEY: KEY_A, NEXTAUTH_SECRET: "one" });
    const sealed = encryptSecret("hunter2");
    env({ SECRETS_ENCRYPTION_KEY: KEY_A, NEXTAUTH_SECRET: "two" });
    expect(decryptSecret(sealed)).toBe("hunter2");
  });

  it("reads values written with the previous key during rotation", () => {
    env({ SECRETS_ENCRYPTION_KEY: KEY_A });
    const old = encryptSecret("hunter2");
    env({ SECRETS_ENCRYPTION_KEY: KEY_B, SECRETS_ENCRYPTION_KEY_PREVIOUS: KEY_A });
    expect(decryptSecret(old)).toBe("hunter2");
    expect(needsReencryption(old)).toBe(true);
    expect(needsReencryption(encryptSecret("x"))).toBe(false);
  });

  it("rejects a key that is not 32 bytes", () => {
    env({ SECRETS_ENCRYPTION_KEY: "too-short" });
    expect(() => encryptSecret("x")).toThrow(SecretKeyConfigError);
  });
});

describe("secret-box in production without the key", () => {
  it("refuses to encrypt instead of using the session secret", () => {
    env({ NEXTAUTH_SECRET: "session-secret" });
    expect(() => encryptSecret("x")).toThrow(SecretKeyConfigError);
  });

  it("still reads legacy v1 values keyed off NEXTAUTH_SECRET", () => {
    env({ NODE_ENV: "development", NEXTAUTH_SECRET: "session-secret" });
    const legacy = encryptSecret("hunter2");
    expect(legacy.startsWith("v1:")).toBe(true);
    env({ NEXTAUTH_SECRET: "session-secret" });
    expect(decryptSecret(legacy)).toBe("hunter2");
  });

  it("never falls back to the hard-coded development secret", () => {
    env({ NODE_ENV: "development" });
    const devOnly = encryptSecret("hunter2");
    env({});
    expect(() => decryptSecret(devOnly)).toThrow(SecretKeyConfigError);
  });
});

describe("reencrypt-secrets.mjs matches secret-box", () => {
  it("upgrades a legacy value the app can then read", () => {
    env({ NODE_ENV: "development", NEXTAUTH_SECRET: "session-secret" });
    const legacy = encryptSecret("hunter2");
    const keys = script.loadKeys({ SECRETS_ENCRYPTION_KEY: KEY_A, NEXTAUTH_SECRET: "session-secret" });
    expect(script.isCurrent(legacy, keys)).toBe(false);
    const upgraded = script.encrypt(script.decrypt(legacy, keys), keys);
    expect(script.isCurrent(upgraded, keys)).toBe(true);
    env({ SECRETS_ENCRYPTION_KEY: KEY_A });
    expect(decryptSecret(upgraded)).toBe("hunter2");
  });

  it("reads what the app writes", () => {
    env({ SECRETS_ENCRYPTION_KEY: KEY_B });
    const sealed = encryptSecret("hunter2");
    const keys = script.loadKeys({ SECRETS_ENCRYPTION_KEY: KEY_B });
    expect(script.decrypt(sealed, keys)).toBe("hunter2");
    expect(script.isCurrent(sealed, keys)).toBe(true);
  });
});
