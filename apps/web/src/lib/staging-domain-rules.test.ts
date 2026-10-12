import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCKED_SUFFIXES,
  MAX_CUSTOM_STAGING_DOMAINS,
  canAddCustomStagingDomain,
  normalizeHostname,
  pickFallbackHost,
  platformSuffixesFromEnv,
  validateCustomStagingHostname
} from "./staging-domain-rules";

const ctx = {
  platformSuffixes: [...DEFAULT_BLOCKED_SUFFIXES, "stage.mfts.link"],
  productionHosts: ["clientsite.com", "www.clientsite.com"],
  knownTlds: ["com", "org", "co.uk", "app"]
};

describe("normalizeHostname", () => {
  it("lowercases and strips scheme, path, port and trailing dot", () => {
    expect(normalizeHostname("  HTTPS://Staging.ClientSite.com:443/path?x=1 ")).toBe("staging.clientsite.com");
    expect(normalizeHostname("staging.clientsite.com.")).toBe("staging.clientsite.com");
  });

  it("converts international names to punycode, as DNS and Coolify see them", () => {
    expect(normalizeHostname("staging.bücher.com")).toBe("staging.xn--bcher-kva.com");
  });

  it("returns an empty string for nothing usable", () => {
    expect(normalizeHostname("   ")).toBe("");
  });
});

describe("validateCustomStagingHostname", () => {
  it("accepts a subdomain of the client's own domain", () => {
    expect(validateCustomStagingHostname("staging.clientsite.com", ctx)).toEqual({ ok: true, hostname: "staging.clientsite.com" });
    expect(validateCustomStagingHostname("preview.shop.client.co.uk", ctx)).toEqual({ ok: true, hostname: "preview.shop.client.co.uk" });
  });

  const rejected: Array<[string, string]> = [
    ["", "empty"],
    ["not a domain", "invalid"],
    ["staging..clientsite.com", "invalid"],
    ["-bad.clientsite.com", "invalid"],
    ["203.0.113.10", "ip_address"],
    ["*.clientsite.com", "wildcard"],
    ["clientsite.org", "apex"],
    ["client.co.uk", "apex"],
    ["anything.mfts.link", "platform_domain"],
    ["mfts.link", "platform_domain"],
    ["x.stage.mfts.link", "platform_domain"],
    ["staging.jongo.app", "platform_domain"],
    ["deep.sub.manifest-fts.com", "platform_domain"],
    ["www.clientsite.com", "production_domain"],
    [`${"a".repeat(64)}.clientsite.com`, "invalid"],
    [`${"abc.".repeat(63)}com`, "too_long"]
  ];

  it.each(rejected)("rejects %s as %s", (input, reason) => {
    const result = validateCustomStagingHostname(input, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.message.length).toBeGreaterThan(10);
    }
  });

  it("does not mistake a lookalike for a platform domain", () => {
    expect(validateCustomStagingHostname("staging.notmfts.link", ctx).ok).toBe(true);
  });
});

describe("per-site limit", () => {
  it("allows two custom domains per site", () => {
    expect(MAX_CUSTOM_STAGING_DOMAINS).toBe(2);
    expect(canAddCustomStagingDomain(0)).toBe(true);
    expect(canAddCustomStagingDomain(1)).toBe(true);
    expect(canAddCustomStagingDomain(2)).toBe(false);
  });
});

describe("pickFallbackHost", () => {
  it("picks the platform host, never a custom domain, whatever the order", () => {
    expect(pickFallbackHost(["staging.clientsite.com", "clientsite.stage.mfts.link"], [], ["staging.clientsite.com"])).toBe("clientsite.stage.mfts.link");
    expect(pickFallbackHost(["https://wordpress-x.manifest-fts.com"], [])).toBe("wordpress-x.manifest-fts.com");
  });

  it("uses a configured platform suffix and falls back to the first non-custom host", () => {
    expect(pickFallbackHost(["a.client.com", "b.preview.example.net"], ["preview.example.net"])).toBe("b.preview.example.net");
    expect(pickFallbackHost(["a.client.com"], [], [])).toBe("a.client.com");
    expect(pickFallbackHost([], [])).toBe("");
  });

  it("reads platform suffixes from the environment", () => {
    expect(platformSuffixesFromEnv({ JONGO_PLATFORM_DOMAIN_SUFFIXES: "Example.net, other.org", STAGING_DOMAIN_SUFFIX: "staging.mfts.link" })).toEqual([
      "example.net",
      "other.org",
      "staging.mfts.link"
    ]);
  });
});
