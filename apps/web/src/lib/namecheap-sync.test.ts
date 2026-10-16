import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDomainList } from "./namecheap-xml";

vi.mock("@/lib/rate-gate", () => ({
  MinIntervalGate: class { acquire = vi.fn(async () => ({ admitted: true })); },
  SingleFlightCache: class {}
}));
import { getDomainListPage } from "./namecheap";

function xml(total = 1, page = 1, size = 100, rows = `<Domain ID="123" Name="EXAMPLE.COM" Expires="01/07/2027" IsExpired="false" AutoRenew="true" />`) {
  return `<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.getList"><DomainGetListResult>${rows}</DomainGetListResult><Paging><TotalItems>${total}</TotalItems><CurrentPage>${page}</CurrentPage><PageSize>${size}</PageSize></Paging></CommandResponse></ApiResponse>`;
}

describe("Namecheap inventory XML", () => {
  it("normalizes domains and reads registrar flags and validated UTC dates", () => {
    expect(parseDomainList(xml())).toEqual({ totalItems: 1, currentPage: 1, pageSize: 100, domains: [
      { domain: "example.com", domainId: "123", expiresAt: new Date("2027-01-07T00:00:00Z"), expired: false, autoRenew: true }
    ] });
    expect(parseDomainList(xml().replace('IsExpired="false"', 'IsExpired="True"')).domains[0].expired).toBe(true);
  });
  it("accepts an empty account and the final short page", () => {
    expect(parseDomainList(xml(0, 1, 100, "")).domains).toEqual([]);
    expect(parseDomainList(xml(101, 2)).currentPage).toBe(2);
    expect(parseDomainList(xml(0, 1, 100, "").replace("<DomainGetListResult></DomainGetListResult>", "<DomainGetListResult />")).totalItems).toBe(0);
  });
  it.each([
    xml().replace(/<Paging>.*<\/Paging>/, ""),
    xml().replace("<TotalItems>1", "<TotalItems>-1"),
    xml().replace("<CurrentPage>1", "<CurrentPage>1.5"),
    xml().replace("<PageSize>100", "<PageSize>101"),
    xml(101), xml(1, 2), xml(0), xml(1, 1, 100, ""),
    xml().replace("01/07/2027", "02/30/2027"),
    xml().replace('AutoRenew="true"', 'AutoRenew="maybe"'),
    xml().replace('Name="EXAMPLE.COM"', 'Name="bad&amp;name.com"'),
    xml(2, 1, 100, `<Domain ID="1" Name="a.com" Expires="01/01/2027" IsExpired="false" AutoRenew="true" /><Domain ID="1" Name="a.com" Expires="01/01/2027" IsExpired="false" AutoRenew="true" />`)
  ])("rejects malformed or inconsistent lists without echoing XML", (input) => {
    expect(() => parseDomainList(input)).toThrow("Invalid Namecheap domain list response.");
  });
});

describe("Namecheap paginated client", () => {
  const fetcher = vi.fn();
  beforeEach(() => {
    vi.stubEnv("NAMECHEAP_API_KEY", "secret-key");
    vi.stubEnv("NAMECHEAP_API_USER", "secret-user");
    vi.stubEnv("NAMECHEAP_CLIENT_IP", "192.0.2.1");
    vi.stubEnv("NAMECHEAP_SANDBOX", "false");
    vi.stubGlobal("fetch", fetcher);
    fetcher.mockReset().mockResolvedValue(new Response(xml()));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it("POSTs credentials and paging in the body, disables caching and redirects", async () => {
    await getDomainListPage();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.namecheap.com/xml.response");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "error" });
    expect(Object.fromEntries(init.body)).toMatchObject({ ApiKey: "secret-key", Command: "namecheap.domains.getList", Page: "1", PageSize: "100", ListType: "ALL" });
  });
  it.each([[0, 100], [101, 100], [1.5, 100], [1, 0], [1, 101], [1, NaN]])("rejects invalid request pagination before fetching", async (page, size) => {
    await expect(getDomainListPage(page, size)).rejects.toMatchObject({ code: "INVALID_PAGINATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed for sandbox before any request", async () => {
    vi.stubEnv("NAMECHEAP_SANDBOX", "true");
    await expect(getDomainListPage()).rejects.toMatchObject({ code: "SANDBOX_DISABLED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a repeated or different page", async () => {
    await expect(getDomainListPage(2)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});