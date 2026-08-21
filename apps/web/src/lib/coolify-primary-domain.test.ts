import { describe, expect, it } from "vitest";
import { extractPrimaryDomain, extractResourceDomains, normalizeDomain } from "./coolify-primary-domain";

describe("normalizeDomain", () => {
  it("strips the scheme and trailing slash Coolify stores", () => {
    expect(normalizeDomain("https://teach.lgbt/")).toBe("teach.lgbt");
    expect(normalizeDomain("http://Example.COM")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
  });

  it("drops a path or port rather than showing it as the domain", () => {
    expect(normalizeDomain("https://example.com:8443/wp-admin")).toBe("example.com");
  });

  it("keeps a real IP address, which is a legitimate host", () => {
    expect(normalizeDomain("http://5.78.216.68")).toBe("5.78.216.68");
  });

  it("returns empty for values that are not a domain", () => {
    for (const bad of ["", "   ", null, undefined, "://", "localhost", "wordpress"]) {
      expect(normalizeDomain(bad as unknown)).toBe("");
    }
    // A bare number must not become a domain: new URL("https://42") yields the
    // IPv4 address 0.0.0.42, so a numeric id would have rendered as one.
    expect(normalizeDomain(42 as unknown)).toBe("");
    expect(normalizeDomain("12345")).toBe("");
  });
});

describe("extractResourceDomains", () => {
  // The exact payloads observed on the live platform.
  it("reads the nested application fqdn, because service.fqdn is undefined", () => {
    const service = { fqdn: undefined, applications: [{ name: "wordpress", fqdn: "https://teach.lgbt/" }] };
    expect(extractResourceDomains(service)).toEqual(["teach.lgbt"]);
  });

  it("splits comma-separated hosts and keeps Coolify's order", () => {
    const service = {
      applications: [{ fqdn: "https://waterfallkeepersofnc.org,https://www.waterfallkeepersofnc.org" }]
    };
    expect(extractResourceDomains(service)).toEqual([
      "waterfallkeepersofnc.org",
      "www.waterfallkeepersofnc.org"
    ]);
  });

  it("prefers the resource's own fqdn when it has one", () => {
    expect(extractResourceDomains({ fqdn: "https://app.example.com" })).toEqual(["app.example.com"]);
  });

  it("de-duplicates a host repeated across fields", () => {
    const resource = {
      fqdn: "https://example.com",
      url: "example.com/",
      applications: [{ fqdn: "https://example.com" }]
    };
    expect(extractResourceDomains(resource)).toEqual(["example.com"]);
  });

  it("returns nothing rather than guessing when Coolify has no domain", () => {
    expect(extractResourceDomains({ applications: [{ fqdn: null }] })).toEqual([]);
    expect(extractResourceDomains({})).toEqual([]);
    expect(extractResourceDomains(null)).toEqual([]);
    expect(extractResourceDomains("nope")).toEqual([]);
  });
});

describe("extractPrimaryDomain", () => {
  it("is the first host Coolify lists", () => {
    expect(
      extractPrimaryDomain({ applications: [{ fqdn: "https://fuscarino.manifest-fts.com,https://fuscarino.com" }] })
    ).toBe("fuscarino.manifest-fts.com");
  });

  it("is empty when there is none, so the caller can fall back", () => {
    expect(extractPrimaryDomain({})).toBe("");
  });
});
