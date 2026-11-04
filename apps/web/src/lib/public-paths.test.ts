import { describe, expect, it } from "vitest";
import { isPublicPath } from "./public-paths";

describe("isPublicPath", () => {
  it("keeps the anonymous domain search and prices public", () => {
    expect(isPublicPath("/api/domains/search")).toBe(true);
    expect(isPublicPath("/api/domains/pricing")).toBe(true);
    expect(isPublicPath("/domains")).toBe(true);
    expect(isPublicPath("/domains/transfer")).toBe(true);
  });
  it("puts every other domain API behind sign-in (orders, refunds, DNS, quotes)", () => {
    expect(isPublicPath("/api/domains/checkout")).toBe(false);
    expect(isPublicPath("/api/domains/quote")).toBe(false);
    expect(isPublicPath("/api/domains/charges/abc/remedies")).toBe(false);
    expect(isPublicPath("/api/domains/abc/dns")).toBe(false);
  });
  it("matches whole path segments, not any prefix", () => {
    expect(isPublicPath("/pricing")).toBe(true);
    expect(isPublicPath("/pricing-internal")).toBe(false);
    expect(isPublicPath("/hostingadmin")).toBe(false);
    expect(isPublicPath("/auth/login")).toBe(true);
  });
  it("still serves Next's generated share images and crawler files", () => {
    expect(isPublicPath("/opengraph-image")).toBe(true);
    expect(isPublicPath("/opengraph-image-1a2b3c")).toBe(true);
    expect(isPublicPath("/robots.txt")).toBe(true);
  });
  it("never makes the whole platform public", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/dashboard")).toBe(false);
  });
});
