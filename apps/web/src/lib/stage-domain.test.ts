import { describe, expect, it } from "vitest";
import { deriveStageDomain, parsePlatformSuffixes } from "./stage-domain";

const PLATFORM = ["manifest-fts.com", "mfts.link"];

describe("deriveStageDomain", () => {
  it("prefixes stage. to a single production domain", () => {
    const r = deriveStageDomain(["gardenstateequality.education"], PLATFORM);
    expect(r.host).toBe("stage.gardenstateequality.education");
    expect(r.reason).toBe("only_domain");
  });

  it("prefers the platform alias over the customer's own domain", () => {
    // The platform domain is wildcard-DNS'd here, so staging resolves
    // immediately instead of waiting on the customer's DNS.
    const r = deriveStageDomain(["millenionfitness.com", "millenion-fitness.manifest-fts.com"], PLATFORM);
    expect(r.host).toBe("stage.millenion-fitness.manifest-fts.com");
    expect(r.reason).toBe("platform_alias");
  });

  it("picks the platform alias out of a long domain list", () => {
    const r = deriveStageDomain(
      [
        "jengo-budget.com",
        "jengobudget.com",
        "jengobudget.manifest-fts.com",
        "jengobudgets.com",
        "jengofinance.com",
        "www.jengo-budget.com",
        "www.jengobudget.com"
      ],
      PLATFORM
    );
    expect(r.host).toBe("stage.jengobudget.manifest-fts.com");
  });

  it("ignores www aliases entirely", () => {
    const r = deriveStageDomain(["www.waterfallkeepersofnc.org", "waterfallkeepersofnc.org"], PLATFORM);
    expect(r.host).toBe("stage.waterfallkeepersofnc.org");
    expect(r.from).toBe("waterfallkeepersofnc.org");
  });

  it("falls back to the customer domain when there is no platform alias", () => {
    const r = deriveStageDomain(["waterfallkeepersofnc.org", "www.waterfallkeepersofnc.org"], PLATFORM);
    expect(r.host).toBe("stage.waterfallkeepersofnc.org");
  });

  it("matches a platform suffix exactly, not as a substring", () => {
    // notmanifest-fts.com must not count as a manifest-fts.com alias.
    const r = deriveStageDomain(["example.notmanifest-fts.com"], PLATFORM);
    expect(r.reason).toBe("only_domain");
    expect(r.host).toBe("stage.example.notmanifest-fts.com");
  });

  it("keeps the id when production itself is an auto-generated host", () => {
    // Inherited from production by design: the fix is to give the site a real
    // domain, not to invent a hostname here.
    const r = deriveStageDomain(["wordpress-xilqqxd9cqmtk47axxo9uvel.manifest-fts.com"], PLATFORM);
    expect(r.host).toBe("stage.wordpress-xilqqxd9cqmtk47axxo9uvel.manifest-fts.com");
  });

  it("never double-prefixes an existing stage host", () => {
    const r = deriveStageDomain(["stage.millenionfitness.com"], PLATFORM);
    expect(r.host).toBe("stage.millenionfitness.com");
    expect(r.reason).toBe("already_stage");
  });

  it("strips scheme, port, path and trailing dots", () => {
    const r = deriveStageDomain(["https://Millenion-Fitness.Manifest-FTS.com:443/wp-admin"], PLATFORM);
    expect(r.host).toBe("stage.millenion-fitness.manifest-fts.com");
  });

  it("returns nothing when there are no usable domains", () => {
    expect(deriveStageDomain([], PLATFORM).reason).toBe("none");
    expect(deriveStageDomain([null, undefined, "  "], PLATFORM).reason).toBe("none");
  });

  it("rejects bare labels with no dot", () => {
    // A container name is not a routable site domain.
    expect(deriveStageDomain(["wordpress-abc123"], PLATFORM).reason).toBe("none");
  });

  it("works with no platform suffixes configured", () => {
    const r = deriveStageDomain(["millenionfitness.com", "millenion-fitness.manifest-fts.com"], []);
    expect(r.host).toBe("stage.millenionfitness.com");
    expect(r.reason).toBe("shortest");
  });

  it("is deterministic when two hosts tie on length", () => {
    const a = deriveStageDomain(["bbb.com", "aaa.com"], []);
    const b = deriveStageDomain(["aaa.com", "bbb.com"], []);
    expect(a.host).toBe(b.host);
  });
});

describe("parsePlatformSuffixes", () => {
  it("splits on commas and whitespace", () => {
    expect(parsePlatformSuffixes("manifest-fts.com, mfts.link")).toEqual(["manifest-fts.com", "mfts.link"]);
    expect(parsePlatformSuffixes("manifest-fts.com mfts.link")).toEqual(["manifest-fts.com", "mfts.link"]);
  });

  it("returns an empty list for empty input", () => {
    expect(parsePlatformSuffixes("")).toEqual([]);
    expect(parsePlatformSuffixes(null)).toEqual([]);
  });
});
