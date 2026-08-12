import { describe, expect, it } from "vitest";
import { nextAvailableSlug, toSiteSlug } from "./site-slug";

describe("toSiteSlug", () => {
  it("lowercases and dash-separates", () => {
    expect(toSiteSlug("Test New App")).toBe("test-new-app");
    expect(toSiteSlug("GimmePower.com")).toBe("gimmepower-com");
  });

  it("trims leading and trailing separators", () => {
    expect(toSiteSlug("  --Hello--  ")).toBe("hello");
  });

  it("caps length without leaving a trailing dash", () => {
    const slug = toSiteSlug("a".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("nextAvailableSlug", () => {
  it("returns the base slug when nothing has claimed it", () => {
    expect(nextAvailableSlug("test-website", [])).toBe("test-website");
  });

  it("steps past a slug held by an ARCHIVED row", () => {
    // The unique constraint spans soft-deleted rows, so an archived app keeps its
    // name reserved and creating it again failed with P2002.
    expect(nextAvailableSlug("test-website", ["test-website"])).toBe("test-website-2");
  });

  it("keeps stepping until it finds a gap", () => {
    expect(nextAvailableSlug("aaaaaaa", ["aaaaaaa", "aaaaaaa-2", "aaaaaaa-3"])).toBe("aaaaaaa-4");
  });

  it("fills a gap in the middle rather than always appending to the end", () => {
    expect(nextAvailableSlug("app", ["app", "app-3"])).toBe("app-2");
  });

  it("compares case-insensitively, since slugs are always lowercased", () => {
    expect(nextAvailableSlug("Test-Website", ["test-website"])).toBe("test-website-2");
  });

  it("ignores blank and null entries in the taken list", () => {
    expect(nextAvailableSlug("app", ["", "   ", null as unknown as string])).toBe("app");
  });

  it("truncates the stem, never the suffix, so the result stays unique", () => {
    const base = "b".repeat(60);
    const slug = nextAvailableSlug(base, [base]);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-2")).toBe(true);
  });

  it("falls back to something that cannot collide rather than looping forever", () => {
    const taken = ["x", ...Array.from({ length: 1000 }, (_, i) => `x-${i + 2}`)];
    const slug = nextAvailableSlug("x", taken);
    expect(taken).not.toContain(slug);
  });

  it("never returns an empty slug for an unusable name", () => {
    expect(nextAvailableSlug("!!!", [])).toBe("app");
  });
});
