import { describe, expect, it } from "vitest";
import { isGeneratedCoolifyHost } from "./coolify-host";

const SERVICE_UUID = "famhksm959h9v4tmxbm3743d";

describe("isGeneratedCoolifyHost", () => {
  it("detects the generated host for a known service uuid", () => {
    expect(
      isGeneratedCoolifyHost(`https://wordpress-${SERVICE_UUID}.manifest-fts.com`, SERVICE_UUID)
    ).toBe(true);
  });

  it("detects sibling containers of the same service", () => {
    expect(
      isGeneratedCoolifyHost(`https://mariadb-${SERVICE_UUID}.manifest-fts.com`, SERVICE_UUID)
    ).toBe(true);
  });

  it("does not flag a generated host belonging to a different service", () => {
    expect(
      isGeneratedCoolifyHost(`https://wordpress-${SERVICE_UUID}.manifest-fts.com`, "zzzzzzzz000000000000aaaa")
    ).toBe(false);
  });

  it("allows preferred staging hosts", () => {
    expect(isGeneratedCoolifyHost("https://staging-wptest.manifest-fts.com", SERVICE_UUID)).toBe(false);
    expect(isGeneratedCoolifyHost("https://staging-testsite.manifest-fts.com")).toBe(false);
  });

  describe("without a service uuid", () => {
    it("falls back to the cuid2 shape Coolify mints", () => {
      expect(isGeneratedCoolifyHost(`https://wordpress-${SERVICE_UUID}.manifest-fts.com`)).toBe(true);
    });

    it("does not flag client domains that merely have a long label", () => {
      expect(isGeneratedCoolifyHost("https://waterfallkeepersofnorthcarolina.com")).toBe(false);
      expect(isGeneratedCoolifyHost("https://my-waterfallkeepersofnorthcarolina.com")).toBe(false);
    });
  });

  it("handles bare hosts and malformed input", () => {
    expect(isGeneratedCoolifyHost("wptest.manifest-fts.com")).toBe(false);
    expect(isGeneratedCoolifyHost("not a url")).toBe(false);
    expect(isGeneratedCoolifyHost("")).toBe(false);
  });
});
