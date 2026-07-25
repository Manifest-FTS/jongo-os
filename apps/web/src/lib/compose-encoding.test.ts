import { describe, expect, it } from "vitest";
import { encodeComposeForCoolify, looksBase64Encoded } from "./compose-encoding";

// The real shape returned by GET /api/v1/services/{uuid} on the live instance.
const RAW_COMPOSE = "services:\n  wordpress:\n    image: 'wordpress:latest'\n    volumes:\n      - 'wp:/var/www/html'\n";

describe("encodeComposeForCoolify", () => {
  it("encodes the raw YAML Coolify hands back, which it refuses on the way in", () => {
    const encoded = encodeComposeForCoolify(RAW_COMPOSE);
    expect(encoded).toBe(Buffer.from(RAW_COMPOSE, "utf8").toString("base64"));
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(RAW_COMPOSE);
  });

  it("does not double-encode something already encoded", () => {
    // Double-encoding would create a service whose compose is a base64 blob —
    // worse than the bug being fixed.
    const once = Buffer.from(RAW_COMPOSE, "utf8").toString("base64");
    expect(encodeComposeForCoolify(once)).toBe(once);
  });

  it("returns empty for empty input rather than encoding nothing into padding", () => {
    expect(encodeComposeForCoolify("")).toBe("");
    expect(encodeComposeForCoolify("   ")).toBe("");
    expect(encodeComposeForCoolify(null)).toBe("");
    expect(encodeComposeForCoolify(undefined)).toBe("");
  });

  it("round-trips compose containing non-ASCII", () => {
    const compose = "services:\n  app:\n    environment:\n      GREETING: 'héllo wörld'\n";
    expect(Buffer.from(encodeComposeForCoolify(compose), "base64").toString("utf8")).toBe(compose);
  });
});

describe("looksBase64Encoded", () => {
  it("recognises encoded compose", () => {
    expect(looksBase64Encoded(Buffer.from(RAW_COMPOSE, "utf8").toString("base64"))).toBe(true);
  });

  it("rejects raw YAML", () => {
    expect(looksBase64Encoded(RAW_COMPOSE)).toBe(false);
  });

  it("rejects a plain word that happens to be base64-safe characters", () => {
    // "services" is all base64 charset and length 8; it must not be mistaken
    // for encoded content, or real compose would be sent through unencoded.
    expect(looksBase64Encoded("services")).toBe(false);
  });

  it("rejects base64 that decodes to something that is not compose", () => {
    expect(looksBase64Encoded(Buffer.from("just some text", "utf8").toString("base64"))).toBe(false);
  });

  it("rejects empty and malformed input", () => {
    expect(looksBase64Encoded("")).toBe(false);
    expect(looksBase64Encoded("!!!!")).toBe(false);
    expect(looksBase64Encoded("abc")).toBe(false);
  });
});
