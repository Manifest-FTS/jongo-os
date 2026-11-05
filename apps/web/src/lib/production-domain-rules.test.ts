import { describe, expect, it } from "vitest";
import { buildFallbackPlugin, choosePrimary, describeHosts, isFallbackHost, isSafeHost, orderHosts } from "./production-domain-rules";

describe("which address is primary", () => {
  const hosts = ["fuscarino.manifest-fts.com", "fuscarino.com"];

  it("prefers the client's domain over Jongo's own address", () => {
    expect(choosePrimary(hosts, null)).toBe("fuscarino.com");
  });

  it("keeps a saved choice while it is still attached", () => {
    expect(choosePrimary(hosts, "fuscarino.manifest-fts.com")).toBe("fuscarino.manifest-fts.com");
  });

  it("ignores a saved choice that was detached", () => {
    expect(choosePrimary(hosts, "old.example.com")).toBe("fuscarino.com");
  });

  it("uses Jongo's address when it is the only one", () => {
    expect(choosePrimary(["a.manifest-fts.com"], null)).toBe("a.manifest-fts.com");
    expect(choosePrimary([], null)).toBeNull();
  });

  it("puts the primary first and keeps every other host", () => {
    expect(orderHosts(["b.manifest-fts.com", "B.com", "b.com"], "b.com")).toEqual(["b.com", "b.manifest-fts.com"]);
  });

  it("labels backup addresses", () => {
    expect(isFallbackHost("x.manifest-fts.com")).toBe(true);
    expect(isFallbackHost("x.mfts.link")).toBe(true);
    expect(isFallbackHost("manifest-fts.com.evil.com")).toBe(false);
    expect(describeHosts(hosts, "fuscarino.com")).toEqual([
      { host: "fuscarino.manifest-fts.com", primary: false, fallback: true },
      { host: "fuscarino.com", primary: true, fallback: false }
    ]);
  });
});

describe("fallback address plugin", () => {
  it("serves the fallback hosts and names the primary", () => {
    const php = buildFallbackPlugin("fuscarino.com", ["fuscarino.manifest-fts.com"])!;
    expect(php).toContain("$jongo_primary = 'fuscarino.com';");
    expect(php).toContain("array('fuscarino.manifest-fts.com')");
    expect(php).toContain("redirect_canonical");
    expect(php).toContain("noindex");
  });

  it("is not needed when there is no separate fallback", () => {
    expect(buildFallbackPlugin("a.manifest-fts.com", ["a.manifest-fts.com"])).toBeNull();
    expect(buildFallbackPlugin("a.com", [])).toBeNull();
  });

  it("refuses anything that isn't a plain hostname", () => {
    expect(isSafeHost("a.com'); system('id');//")).toBe(false);
    expect(isSafeHost("localhost")).toBe(false);
    expect(() => buildFallbackPlugin("a.com", ["x.com'; echo"])).toThrow();
  });
});
