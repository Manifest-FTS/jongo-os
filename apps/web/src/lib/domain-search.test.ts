import { describe, expect, it } from "vitest";
import {
  buildDomainCandidates,
  formatCents,
  normalizeDomainQuery,
  parseDomain,
  toCents
} from "./domain-search";

describe("normalizeDomainQuery", () => {
  it("strips a scheme, path, query and port", () => {
    expect(normalizeDomainQuery("https://www.Example.com:8443/pricing?x=1#top")).toBe("www.example.com");
  });

  it("strips a userinfo segment rather than reading it as the host", () => {
    expect(normalizeDomainQuery("mailto:someone@example.com")).toBe("example.com");
    expect(normalizeDomainQuery("https://user:pass@example.com/")).toBe("example.com");
  });

  it("drops the trailing root dot of a fully-qualified name", () => {
    expect(normalizeDomainQuery("example.com.")).toBe("example.com");
  });

  it("keeps a leading www, because searching for something else would be a lie", () => {
    // "www.example.com" is what they typed. Quietly checking "example.com"
    // and reporting on THAT is the failure mode this avoids.
    expect(normalizeDomainQuery("www.example.com")).toBe("www.example.com");
  });

  it("returns empty for blank input", () => {
    expect(normalizeDomainQuery("   ")).toBe("");
    expect(normalizeDomainQuery("")).toBe("");
  });
});

describe("parseDomain", () => {
  it("splits a simple domain", () => {
    expect(parseDomain("northfield.com")).toEqual({
      label: "northfield",
      tld: "com",
      domain: "northfield.com"
    });
  });

  it("prefers the longest known multi-part suffix", () => {
    expect(parseDomain("northfield.co.uk", ["uk", "co.uk", "com"])).toEqual({
      label: "northfield",
      tld: "co.uk",
      domain: "northfield.co.uk"
    });
  });

  it("falls back to the last label when no suffix list is given", () => {
    // Without a list there is no way to know "co.uk" is a suffix, so this
    // resolves to a subdomain and is refused rather than guessed at.
    expect(parseDomain("northfield.co.uk")).toBeNull();
  });

  it("refuses a subdomain, rather than reducing it to the registrable part", () => {
    expect(parseDomain("staging.northfield.com")).toBeNull();
  });

  it("refuses input with no dot", () => {
    expect(parseDomain("northfield")).toBeNull();
  });

  it("refuses empty labels and malformed names", () => {
    expect(parseDomain("northfield..com")).toBeNull();
    expect(parseDomain(".com")).toBeNull();
    expect(parseDomain("-northfield.com")).toBeNull();
    expect(parseDomain("northfield-.com")).toBeNull();
  });

  it("refuses a name longer than the DNS limit", () => {
    expect(parseDomain(`${"a".repeat(250)}.com`)).toBeNull();
  });

  it("accepts inner hyphens and digits", () => {
    expect(parseDomain("north-field-2.com")?.label).toBe("north-field-2");
  });
});

describe("buildDomainCandidates", () => {
  it("checks a dotted query exactly as typed", () => {
    const candidates = buildDomainCandidates("northfield.com");
    expect(candidates.map((entry) => entry.domain)).toEqual(["northfield.com"]);
  });

  it("fans a bare word out across the suggested TLDs", () => {
    const candidates = buildDomainCandidates("northfield", { tlds: ["com", "io"] });
    expect(candidates.map((entry) => entry.domain)).toEqual(["northfield.com", "northfield.io"]);
  });

  it("returns nothing for a query that cannot be a domain", () => {
    expect(buildDomainCandidates("   ")).toEqual([]);
    expect(buildDomainCandidates("not a domain!")).toEqual([]);
    expect(buildDomainCandidates("staging.northfield.com")).toEqual([]);
  });
});

describe("toCents", () => {
  it("converts the decimal strings the API returns", () => {
    expect(toCents("11.08")).toBe(1108);
    expect(toCents("9.73")).toBe(973);
    expect(toCents("8.99")).toBe(899);
    expect(toCents("51.80")).toBe(5180);
  });

  it("survives the float cases that would otherwise be a cent out", () => {
    // 8.99 * 100 === 898.9999999999999 and 11.08 * 100 === 1108.0000000000002
    // in IEEE754. This is the reason the conversion is string-based.
    for (let cents = 1; cents <= 10000; cents += 1) {
      const decimal = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      expect(toCents(decimal)).toBe(cents);
    }
  });

  it("handles whole numbers and single decimal places", () => {
    expect(toCents("12")).toBe(1200);
    expect(toCents("12.5")).toBe(1250);
  });

  it("tolerates a currency symbol and thousands separators", () => {
    expect(toCents("$1,234.56")).toBe(123456);
  });

  it("accepts a number as well as a string", () => {
    expect(toCents(11.08)).toBe(1108);
  });

  it("returns null for anything unreadable, so it can never become free", () => {
    expect(toCents("")).toBeNull();
    expect(toCents("free")).toBeNull();
    expect(toCents("11.08 USD")).toBeNull();
    expect(toCents("-5.00")).toBeNull();
    expect(toCents(null)).toBeNull();
    expect(toCents(undefined)).toBeNull();
  });
});

describe("formatCents", () => {
  it("renders cents as a price", () => {
    expect(formatCents(1108)).toBe("$11.08");
    expect(formatCents(900)).toBe("$9.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("shows a dash rather than a zero for an unknown price", () => {
    expect(formatCents(null)).toBe("—");
    expect(formatCents(undefined)).toBe("—");
    expect(formatCents(Number.NaN)).toBe("—");
  });

  it("round-trips with toCents", () => {
    for (const price of ["11.08", "9.73", "0.99", "1234.56"]) {
      expect(formatCents(toCents(price))).toBe(`$${price}`);
    }
  });
});
