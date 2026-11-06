import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CODE_CHALLENGE_METHOD, isValidCodeChallenge, isValidCodeVerifier, s256Challenge, verifyPkceS256 } from "./pkce";

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // RFC 7636 appendix B

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(s256Challenge(verifier)).toBe(challenge);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(CODE_CHALLENGE_METHOD).toBe("S256");
  });

  it("rejects an incorrect verifier", () => {
    expect(verifyPkceS256("a".repeat(43), challenge)).toBe(false);
    expect(verifyPkceS256(verifier + "x", challenge)).toBe(false);
  });

  it("rejects a missing or empty verifier or challenge", () => {
    for (const bad of [undefined, null, "", 42, {}]) {
      expect(verifyPkceS256(bad, challenge)).toBe(false);
      expect(verifyPkceS256(verifier, bad)).toBe(false);
    }
  });

  it("rejects the plain method: the challenge equal to the verifier is not a valid S256 challenge", () => {
    // Under `plain`, challenge === verifier. Under S256 that must never verify.
    expect(verifyPkceS256(verifier, verifier)).toBe(false);
  });

  it("enforces RFC 7636 verifier shape (43-128 unreserved characters)", () => {
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42) + "!")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42) + " ")).toBe(false);
  });

  it("accepts only 43-char base64url challenges", () => {
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(isValidCodeChallenge(challenge + "=")).toBe(false);
    expect(isValidCodeChallenge(challenge.slice(1))).toBe(false);
    expect(isValidCodeChallenge(createHash("sha256").update("x").digest("hex"))).toBe(false);
  });
});
