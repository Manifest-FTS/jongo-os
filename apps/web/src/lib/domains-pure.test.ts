import { describe, expect, it } from "vitest";
import {
  apiErrors,
  apiStatus,
  isTransferDead,
  parseBalance,
  parseCheck,
  parseCreate,
  parseGetInfo,
  parseNamecheapDate,
  parseRenew,
  parseSetCustom,
  parseTldPriceBooks,
  parseTransferCreate
} from "./namecheap-xml";
import { applyMarkup, quoteDomain, readMarkupPercent, wholesaleCents } from "./domain-pricing";
import { normalizePhone, toNamecheapContactParams, validateContact } from "./domain-contact";
import { fullRecordName, shortRecordName, validateDnsRecord } from "./dns-record";

// Shapes observed against the live API (values trimmed, structure kept).
const PRICING_COM = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response"><Errors /><CommandResponse Type="namecheap.users.getPricing">
<UserGetPricingResult><ProductType Name="domains">
<ProductCategory Name="register"><Product Name="com">
<Price Duration="1" DurationType="YEAR" Price="11.28" PricingType="ABSOLUTE" AdditionalCost="0.20" RegularPrice="14.98" YourPrice="11.28" YourPriceType="ABSOLUTE" YourAdditonalCost="0.20" YourAdditonalCostType="MULTIPLE" Currency="USD" />
<Price Duration="2" DurationType="YEAR" Price="26.26" PricingType="ABSOLUTE" AdditionalCost="0.20" YourPrice="26.26" YourAdditonalCost="0.20" Currency="USD" />
</Product></ProductCategory>
<ProductCategory Name="renew"><Product Name="com">
<Price Duration="1" DurationType="YEAR" Price="14.98" YourPrice="14.98" YourAdditonalCost="0.20" Currency="USD" />
</Product></ProductCategory>
<ProductCategory Name="reactivate"><Product Name="com"><Price Duration="1" DurationType="YEAR" YourPrice="14.98" /></Product></ProductCategory>
<ProductCategory Name="transfer"><Product Name="com">
<Price Duration="1" DurationType="YEAR" Price="11.48" YourPrice="11.48" YourAdditonalCost="0.20" Currency="USD" />
</Product></ProductCategory>
</ProductType></UserGetPricingResult></CommandResponse></ApiResponse>`;

const PRICING_IO = `<ApiResponse Status="OK"><CommandResponse><UserGetPricingResult><ProductType Name="domains">
<ProductCategory Name="register"><Product Name="io"><Price Duration="1" DurationType="YEAR" Price="34.98" YourPrice="34.98" Currency="USD" /></Product></ProductCategory>
<ProductCategory Name="transfer"><Product Name="io"><Price Duration="1" DurationType="YEAR" YourPrice="65.98" Currency="USD" /></Product></ProductCategory>
</ProductType></UserGetPricingResult></CommandResponse></ApiResponse>`;

const ERROR = `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response"><Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error></Errors></ApiResponse>`;

describe("namecheap-xml", () => {
  it("reads status and errors", () => {
    expect(apiStatus(ERROR)).toBe("ERROR");
    expect(apiErrors(ERROR)).toEqual([{ number: "1011102", message: "API Key is invalid or API access has not been enabled" }]);
    expect(apiStatus(PRICING_COM)).toBe("OK");
  });

  it("reads a price book: term totals, per-year ICANN fee, ignoring other categories", () => {
    const com = parseTldPriceBooks(PRICING_COM).get("com")!;
    expect(com.register).toEqual([
      { years: 1, priceCents: 1128, additionalCents: 20 },
      { years: 2, priceCents: 2626, additionalCents: 20 }
    ]);
    expect(com.renew).toEqual([{ years: 1, priceCents: 1498, additionalCents: 20 }]);
    expect(com.transfer).toEqual([{ years: 1, priceCents: 1148, additionalCents: 20 }]);
  });

  it("treats a missing ICANN fee as zero (.io has none)", () => {
    expect(parseTldPriceBooks(PRICING_IO).get("io")!.register).toEqual([{ years: 1, priceCents: 3498, additionalCents: 0 }]);
  });

  it("reads availability, including premium names", () => {
    const xml = `<ApiResponse Status="OK"><CommandResponse>
      <DomainCheckResult Domain="jongo-probe.com" Available="true" ErrorNo="0" Description="" IsPremiumName="false" PremiumRegistrationPrice="0" />
      <DomainCheckResult Domain="Jongo.app" Available="false" ErrorNo="0" Description="" IsPremiumName="false" PremiumRegistrationPrice="0" />
      <DomainCheckResult Domain="cars.io" Available="true" ErrorNo="0" Description="" IsPremiumName="true" PremiumRegistrationPrice="2500.00" />
    </CommandResponse></ApiResponse>`;
    expect(parseCheck(xml)).toEqual([
      { domain: "jongo-probe.com", available: true, premium: false, premiumRegistrationCents: 0, errorNo: "0", description: "" },
      { domain: "jongo.app", available: false, premium: false, premiumRegistrationCents: 0, errorNo: "0", description: "" },
      { domain: "cars.io", available: true, premium: true, premiumRegistrationCents: 250000, errorNo: "0", description: "" }
    ]);
  });

  it("reads order results", () => {
    expect(parseCreate(`<DomainCreateResult Domain="a.com" Registered="true" ChargedAmount="11.48" DomainID="9007" OrderID="196074" TransactionID="380716" WhoisguardEnable="true" />`)).toMatchObject({
      domain: "a.com", succeeded: true, chargedCents: 1148, domainId: "9007", orderId: "196074", transactionId: "380716"
    });
    expect(parseRenew(`<DomainRenewResult DomainName="a.com" DomainID="1" Renew="true" OrderID="2" TransactionID="3" ChargedAmount="15.1800"><DomainDetails><ExpiredDate>01/07/2028</ExpiredDate></DomainDetails></DomainRenewResult>`)).toMatchObject({
      succeeded: true, chargedCents: 1518, expiresAt: new Date(Date.UTC(2028, 0, 7))
    });
    expect(parseTransferCreate(`<DomainTransferCreateResult DomainName="a.com" Transfer="true" TransferID="15" StatusID="-1" OrderID="1" TransactionID="2" ChargedAmount="11.68" />`)).toMatchObject({
      succeeded: true, transferId: "15", chargedCents: 1168
    });
    expect(parseCreate("<nothing/>")).toBeNull();
  });

  it("reads domain info, as returned for an existing domain", () => {
    const xml = `<DomainGetInfoResult Status="Ok" ID="97334684" DomainName="jengo-budget.com" OwnerName="x" IsOwner="true" IsPremium="false"> <DomainDetails> <CreatedDate>01/07/2026</CreatedDate> <ExpiredDate>01/07/2027</ExpiredDate> </DomainDetails> <Whoisguard Enabled="True"> </Whoisguard> <DnsDetails ProviderType="CUSTOM" IsUsingOurDNS="false" HostCount="2"> <Nameserver>duke.ns.cloudflare.com</Nameserver> <Nameserver>novalee.ns.cloudflare.com</Nameserver> </DnsDetails></DomainGetInfoResult>`;
    expect(parseGetInfo(xml)).toEqual({
      domain: "jengo-budget.com",
      isOwner: true,
      status: "Ok",
      createdAt: new Date(Date.UTC(2026, 0, 7)),
      expiresAt: new Date(Date.UTC(2027, 0, 7)),
      nameservers: ["duke.ns.cloudflare.com", "novalee.ns.cloudflare.com"],
      usingRegistrarDns: false,
      whoisguard: true
    });
  });

  it("reads set-custom-nameservers, balance, dates and dead transfers", () => {
    expect(parseSetCustom(`<DomainDNSSetCustomResult Domain="a.com" Updated="true" />`)).toBe(true);
    expect(parseBalance(`<UserGetBalancesResult Currency="USD" AvailableBalance="6.09" />`)).toEqual({ availableCents: 609, currency: "USD" });
    expect(parseNamecheapDate("13/45/2027")).toBeNull();
    expect(isTransferDead({ transferId: "1", status: "Cancelled", statusId: "8" })).toBe(true);
    expect(isTransferDead({ transferId: "1", status: "Awaiting EPP code", statusId: "-1" })).toBe(false);
  });
});

describe("domain-pricing", () => {
  const com = parseTldPriceBooks(PRICING_COM).get("com")!;

  it("reads DOMAIN_MARKUP_PERCENTAGE, defaulting and clamping bad values", () => {
    expect(readMarkupPercent("25")).toBe(25);
    expect(readMarkupPercent("22.5")).toBe(22.5);
    expect(readMarkupPercent("")).toBe(25);
    expect(readMarkupPercent("abc")).toBe(25);
    expect(readMarkupPercent("-5")).toBe(25);
    expect(readMarkupPercent("5000")).toBe(300);
  });

  it("rounds the client price UP, so the margin is never shaved", () => {
    expect(applyMarkup(1148, 25)).toEqual({ markupCents: 287, clientCents: 1435 });
    expect(applyMarkup(1001, 25)).toEqual({ markupCents: 251, clientCents: 1252 }); // 1251.25 -> 1252
    expect(applyMarkup(1000, 0)).toEqual({ markupCents: 0, clientCents: 1000 });
  });

  it("adds the per-year ICANN fee to the term total", () => {
    expect(wholesaleCents(com, "register", 1)).toBe(1148);
    expect(wholesaleCents(com, "register", 2)).toBe(2666); // 26.26 + 2 x 0.20
    expect(wholesaleCents(com, "renew", 1)).toBe(1518);
    expect(wholesaleCents(com, "register", 3)).toBeNull(); // no price for that term
  });

  it("quotes a transfer as one year whatever is asked", () => {
    expect(quoteDomain(com, "transfer", 5, 25)).toEqual({
      operation: "transfer", years: 1, wholesaleCents: 1168, markupPercent: 25, markupCents: 292, clientCents: 1460
    });
  });

  it("logs all four figures for audit", () => {
    const quote = quoteDomain(com, "register", 1, 30)!;
    expect(quote.wholesaleCents + quote.markupCents).toBe(quote.clientCents);
    expect(quote).toMatchObject({ wholesaleCents: 1148, markupPercent: 30, clientCents: 1493 });
  });
});

describe("domain-contact", () => {
  const good = {
    firstName: "Ada", lastName: "Lovelace", address1: "1 Main St", city: "Trenton", stateProvince: "NJ",
    postalCode: "08608", country: "us", phone: "(609) 555-0100", email: "ada@example.org"
  };

  it("normalises phone numbers to +CC.NUMBER", () => {
    expect(normalizePhone("(609) 555-0100", "US")).toBe("+1.6095550100");
    expect(normalizePhone("+1 609 555 0100", "GB")).toBe("+1.6095550100");
    expect(normalizePhone("+44.2071234567", "GB")).toBe("+44.2071234567");
    // Without a "+", only US/CA can be assumed; anything else must say its code.
    expect(normalizePhone("020 7123 4567", "GB")).toBeNull();
    expect(normalizePhone("+44 20 7123 4567", "GB")).toBeNull();
  });

  it("accepts a complete contact and upper-cases the country", () => {
    const result = validateContact(good);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contact).toMatchObject({ country: "US", phone: "+1.6095550100" });
  });

  it("names every missing or bad field", () => {
    const result = validateContact({ ...good, firstName: "", email: "nope", country: "USA" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["country", "email", "firstName", "phone"]);
  });

  it("fills all four Namecheap roles", () => {
    const result = validateContact(good);
    if (!result.ok) throw new Error("expected ok");
    const params = toNamecheapContactParams(result.contact);
    for (const role of ["Registrant", "Tech", "Admin", "AuxBilling"]) {
      expect(params[`${role}EmailAddress`]).toBe("ada@example.org");
      expect(params[`${role}Phone`]).toBe("+1.6095550100");
    }
    expect(params.RegistrantOrganizationName).toBeUndefined();
  });
});

describe("dns-record", () => {
  it("expands and shortens names against the zone", () => {
    expect(fullRecordName("@", "acme.org")).toBe("acme.org");
    expect(fullRecordName("www", "acme.org")).toBe("www.acme.org");
    expect(fullRecordName("www.acme.org.", "acme.org")).toBe("www.acme.org");
    expect(shortRecordName("acme.org", "acme.org")).toBe("@");
    expect(shortRecordName("mail.acme.org", "acme.org")).toBe("mail");
  });

  it("accepts the common records", () => {
    expect(validateDnsRecord({ type: "a", name: "@", content: "5.78.216.68", proxied: true }).ok).toBe(true);
    expect(validateDnsRecord({ type: "CNAME", name: "www", content: "acme.org", ttl: 1 }).ok).toBe(true);
    expect(validateDnsRecord({ type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none" }).ok).toBe(true);
    const mx = validateDnsRecord({ type: "MX", name: "@", content: "mx1.example.net", priority: 5 });
    expect(mx.ok && mx.record.priority).toBe(5);
  });

  it("explains what is wrong", () => {
    const bad = validateDnsRecord({ type: "A", name: "@", content: "not-an-ip", ttl: 5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["content", "ttl"]);
    const proxiedTxt = validateDnsRecord({ type: "TXT", name: "@", content: "x", proxied: true });
    expect(!proxiedTxt.ok && proxiedTxt.errors.proxied).toBeTruthy();
    expect(validateDnsRecord({ type: "NS", name: "@", content: "a.b" }).ok).toBe(false);
  });
});
