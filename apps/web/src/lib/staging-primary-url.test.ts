import { describe, expect, it } from "vitest";
import { resolvePrimaryStagingHost, stagingHostsForRewrite, type CustomDomainState } from "./staging-primary-url";

const fallbackHost = "clientsite.stage.mfts.link";
const domain = (hostname: string, partial: Partial<CustomDomainState> = {}): CustomDomainState => ({
  hostname,
  status: "active",
  sslStatus: "issued",
  createdAt: "2026-10-01T00:00:00Z",
  ...partial
});

describe("resolvePrimaryStagingHost", () => {
  it("uses the .mfts.link host when there is no custom domain", () => {
    expect(resolvePrimaryStagingHost({ fallbackHost, customDomains: [] })).toEqual({ host: fallbackHost, source: "fallback" });
  });

  it("uses a custom domain only once it is active AND its certificate is issued", () => {
    for (const notReady of [
      domain("staging.clientsite.com", { status: "pending_dns", sslStatus: "none" }),
      domain("staging.clientsite.com", { status: "verified", sslStatus: "none" }),
      domain("staging.clientsite.com", { status: "active", sslStatus: "pending" }),
      domain("staging.clientsite.com", { status: "active", sslStatus: "failed" })
    ]) {
      expect(resolvePrimaryStagingHost({ fallbackHost, customDomains: [notReady] }).source).toBe("fallback");
    }
    expect(resolvePrimaryStagingHost({ fallbackHost, customDomains: [domain("staging.clientsite.com")] })).toEqual({
      host: "staging.clientsite.com",
      source: "custom"
    });
  });

  it("falls back to .mfts.link when DNS is lost or the domain is removed", () => {
    expect(resolvePrimaryStagingHost({ fallbackHost, customDomains: [domain("staging.clientsite.com", { status: "dns_lost" })] }).host).toBe(fallbackHost);
    expect(resolvePrimaryStagingHost({ fallbackHost, customDomains: [domain("staging.clientsite.com", { status: "removed" })] }).host).toBe(fallbackHost);
  });

  it("picks the oldest ready custom domain when there are two", () => {
    const customDomains = [
      domain("preview.clientsite.com", { createdAt: "2026-10-05T00:00:00Z" }),
      domain("staging.clientsite.com", { createdAt: "2026-10-02T00:00:00Z" })
    ];
    expect(resolvePrimaryStagingHost({ fallbackHost, customDomains }).host).toBe("staging.clientsite.com");
  });
});

describe("stagingHostsForRewrite", () => {
  it("lists every host staging content may reference, primary first, without duplicates", () => {
    const customDomains = [
      domain("staging.clientsite.com"),
      domain("preview.clientsite.com", { status: "dns_lost", createdAt: "2026-10-03T00:00:00Z" }),
      domain("old.clientsite.com", { status: "removed" })
    ];
    expect(stagingHostsForRewrite({ fallbackHost, customDomains })).toEqual([
      "staging.clientsite.com",
      "clientsite.stage.mfts.link",
      "preview.clientsite.com"
    ]);
  });

  it("is just the fallback host when there are no custom domains", () => {
    expect(stagingHostsForRewrite({ fallbackHost, customDomains: [] })).toEqual([fallbackHost]);
  });
});
