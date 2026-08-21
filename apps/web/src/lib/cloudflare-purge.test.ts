import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeCloudflareCache, zoneCandidates } from "./cloudflare-purge";

describe("zoneCandidates", () => {
  it("walks up from the most specific name, because a subdomain can be its own zone", () => {
    expect(zoneCandidates("shop.a.example.com")).toEqual([
      "shop.a.example.com",
      "a.example.com",
      "example.com"
    ]);
  });

  it("handles an apex and a www host", () => {
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
    expect(zoneCandidates("www.example.com")).toEqual(["www.example.com", "example.com"]);
  });

  it("never asks about a bare TLD, which nobody owns", () => {
    expect(zoneCandidates("example.com")).not.toContain("com");
    expect(zoneCandidates("a.b.c.dev").at(-1)).toBe("c.dev");
  });

  it("returns nothing for values that are not hostnames", () => {
    for (const bad of ["", "   ", "localhost", "com", null, undefined]) {
      expect(zoneCandidates(bad as unknown as string)).toEqual([]);
    }
  });
});

describe("purgeCloudflareCache", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delete process.env.CLOUDFLARE_ZONE_ID;
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  const ok = (body: unknown) => ({ status: 200, json: async () => body });

  it("is 'absent', never 'failed', when Cloudflare is not configured", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    // A site with no CDN must not turn a successful local flush into a failure.
    await expect(purgeCloudflareCache("example.com")).resolves.toEqual({
      status: "absent",
      reason: "not_configured"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is 'absent' when the domain is on no Cloudflare zone", async () => {
    fetchMock.mockResolvedValue(ok({ success: true, result: [] }));
    await expect(purgeCloudflareCache("not-on-cloudflare.test")).resolves.toEqual({
      status: "absent",
      reason: "no_zone_for_domain"
    });
  });

  it("finds the zone by walking up and purges it", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ success: true, result: [] })) // www.example.com — no zone
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: "zone123", name: "example.com" }] }))
      .mockResolvedValueOnce(ok({ success: true, result: { id: "purge1" } }));

    await expect(purgeCloudflareCache("www.example.com")).resolves.toEqual({
      status: "flushed",
      zone: "example.com"
    });

    const purge = fetchMock.mock.calls[2];
    expect(purge[0]).toContain("/zones/zone123/purge_cache");
    expect(purge[1].method).toBe("POST");
    expect(JSON.parse(purge[1].body)).toEqual({ purge_everything: true });
  });

  it("sends the token as a bearer credential and never in the URL", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: "z", name: "example.com" }] }))
      .mockResolvedValueOnce(ok({ success: true, result: {} }));
    await purgeCloudflareCache("example.com");
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("test-token");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    }
  });

  it("skips discovery when a zone is pinned", async () => {
    process.env.CLOUDFLARE_ZONE_ID = "pinned-zone";
    fetchMock.mockResolvedValue(ok({ success: true, result: {} }));
    await expect(purgeCloudflareCache("anything.test")).resolves.toEqual({
      status: "flushed",
      zone: "anything.test"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/zones/pinned-zone/purge_cache");
  });

  it("reports 'failed' — not 'absent' — when a zone exists but the purge is refused", async () => {
    // This is the one case where the page really may still be stale, so it must
    // never be reported as "there was nothing to do".
    fetchMock
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: "z", name: "example.com" }] }))
      .mockResolvedValueOnce({ status: 403, json: async () => ({ success: false, errors: [{ message: "Insufficient permissions" }] }) });

    await expect(purgeCloudflareCache("example.com")).resolves.toEqual({
      status: "failed",
      reason: "Insufficient permissions"
    });
  });

  it("reports 'failed' when the request throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const result = await purgeCloudflareCache("example.com");
    expect(result.status).toBe("failed");
  });
});
