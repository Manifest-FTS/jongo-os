import { describe, expect, it } from "vitest";
import { evaluateDns, isCloudflareIp, type DnsObservation } from "./staging-dns-check";

const expected = { cnameTarget: "clientsite.stage.mfts.link", targetIps: ["5.78.216.68"] };
const observe = (partial: Partial<DnsObservation>): DnsObservation => ({ cnames: [], a: [], aaaa: [], ...partial });

describe("evaluateDns", () => {
  it("accepts a CNAME to the site's fallback host, ignoring case and the trailing dot", () => {
    expect(evaluateDns(observe({ cnames: ["ClientSite.Stage.MFTS.link."], a: ["5.78.216.68"] }), expected)).toEqual({ ok: true, via: "cname" });
  });

  it("accepts an A record to the server for DNS hosts that cannot CNAME", () => {
    expect(evaluateDns(observe({ a: ["5.78.216.68"] }), expected)).toEqual({ ok: true, via: "a_record" });
  });

  it("detects the Cloudflare proxy (orange cloud) and says so", () => {
    const verdict = evaluateDns(observe({ a: ["104.21.73.19", "172.67.137.73"] }), expected);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("cloudflare_proxied");
      expect(verdict.message).toMatch(/DNS only|grey/i);
    }
  });

  it("reports a record that points somewhere else, with what was found", () => {
    const verdict = evaluateDns(observe({ cnames: ["oldhost.example.net"], a: ["198.51.100.7"] }), expected);
    expect(verdict).toMatchObject({ ok: false, reason: "points_elsewhere", found: ["oldhost.example.net", "198.51.100.7"] });
  });

  it("refuses when only some A records point at us", () => {
    expect(evaluateDns(observe({ a: ["5.78.216.68", "198.51.100.7"] }), expected)).toMatchObject({ ok: false, reason: "points_elsewhere" });
  });

  it("flags a stray AAAA record, which would send IPv6 visitors and Let's Encrypt elsewhere", () => {
    expect(evaluateDns(observe({ a: ["5.78.216.68"], aaaa: ["2001:db8::1"] }), expected)).toMatchObject({ ok: false, reason: "ipv6_mismatch" });
  });

  it("treats no record and NXDOMAIN as 'not created yet'", () => {
    expect(evaluateDns(observe({}), expected)).toMatchObject({ ok: false, reason: "no_record" });
    expect(evaluateDns(observe({ error: "nxdomain" }), expected)).toMatchObject({ ok: false, reason: "no_record" });
  });

  it("treats a timeout or server failure as 'could not check', not as wrong", () => {
    expect(evaluateDns(observe({ error: "timeout" }), expected)).toMatchObject({ ok: false, reason: "lookup_failed" });
    expect(evaluateDns(observe({ error: "servfail" }), expected)).toMatchObject({ ok: false, reason: "lookup_failed" });
  });
});

describe("isCloudflareIp", () => {
  it("recognises Cloudflare's published ranges", () => {
    expect(isCloudflareIp("104.21.73.19")).toBe(true);
    expect(isCloudflareIp("172.67.137.73")).toBe(true);
    expect(isCloudflareIp("188.114.96.1")).toBe(true);
    expect(isCloudflareIp("2606:4700::6812:4913")).toBe(true);
  });

  it("does not flag ordinary addresses", () => {
    expect(isCloudflareIp("5.78.216.68")).toBe(false);
    expect(isCloudflareIp("8.8.8.8")).toBe(false);
    expect(isCloudflareIp("not-an-ip")).toBe(false);
  });
});
