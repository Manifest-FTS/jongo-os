import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubSignature } from "./github-signature";

const secret = "s3cret";
const body = JSON.stringify({ ref: "refs/heads/main" });
const sign = (value: string, key = secret) => `sha256=${createHmac("sha256", key).update(value).digest("hex")}`;

describe("verifyGithubSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyGithubSignature(body, sign(body), secret)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyGithubSignature(body + " ", sign(body), secret)).toBe(false);
  });
  it("rejects the wrong secret", () => {
    expect(verifyGithubSignature(body, sign(body, "other"), secret)).toBe(false);
  });
  it("rejects a missing or legacy sha1 header", () => {
    expect(verifyGithubSignature(body, null, secret)).toBe(false);
    expect(verifyGithubSignature(body, `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`, secret)).toBe(false);
  });
  it("rejects a truncated signature without throwing", () => {
    expect(verifyGithubSignature(body, sign(body).slice(0, 20), secret)).toBe(false);
  });
  it("rejects when no secret is configured", () => {
    expect(verifyGithubSignature(body, sign(body, ""), "")).toBe(false);
  });
});
