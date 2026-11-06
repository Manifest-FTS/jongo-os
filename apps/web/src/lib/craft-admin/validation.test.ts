import { describe, expect, it } from "vitest";
import {
  MAX_REDIRECT_URIS, parseClientName, parseClientStatus, parseCraftRole, parseDatasetName, parseEmail, parseRedirectUris, hasOnlyKeys
} from "./validation";
import { buildEnvSnippet, CRAFT_RP_ENV, SECRET_PLACEHOLDER } from "./shared";
import { splitUriLines, formatDay } from "@/components/craft/helpers";

describe("redirect URI validation", () => {
  const good = [
    "https://golf.example/craft/auth/callback",
    "https://golf.example",
    "https://sub.golf.example:8443/a/b?x=1",
    "https://xn--bcher-kva.example/cb"
  ];
  it.each(good)("accepts %s", (uri) => {
    const parsed = parseRedirectUris([uri], true);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.redirectUris).toEqual([uri]);
  });

  const bad: Array<[string, string]> = [
    ["wildcard host", "https://*.golf.example/cb"],
    ["wildcard path", "https://golf.example/*"],
    ["wildcard in query", "https://golf.example/cb?x=*"],
    ["fragment", "https://golf.example/cb#frag"],
    ["empty fragment", "https://golf.example/cb#"],
    ["userinfo", "https://user:pw@golf.example/cb"],
    ["username only", "https://user@golf.example/cb"],
    ["http remote", "http://golf.example/cb"],
    ["http lookalike of localhost", "http://localhost.evil.example/cb"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,x"],
    ["ftp", "ftp://golf.example/cb"],
    ["scheme-relative", "//golf.example/cb"],
    ["relative path", "/craft/auth/callback"],
    ["empty", ""],
    ["spaces", "https://golf.example/a b"],
    ["leading space", " https://golf.example/cb"],
    ["trailing newline", "https://golf.example/cb\n"],
    ["backslash", "https:\\\\golf.example\\cb"],
    ["control char", "https://golf.example/\u0001"],
    ["not a url", "golf.example/cb"]
  ];
  it.each(bad)("rejects %s", (_name, uri) => {
    expect(parseRedirectUris([uri], false).ok).toBe(false);
  });

  it("allows http loopback only outside production", () => {
    for (const uri of ["http://localhost/cb", "http://localhost:3000/craft/auth/callback", "http://127.0.0.1:3000/cb", "http://[::1]:3000/cb"]) {
      expect(parseRedirectUris([uri], false).ok, uri).toBe(true);
      expect(parseRedirectUris([uri], true).ok, uri).toBe(false);
    }
  });

  it("bounds the list and each entry", () => {
    expect(parseRedirectUris([], false).ok).toBe(false);
    expect(parseRedirectUris("https://golf.example/cb", false).ok).toBe(false);
    expect(parseRedirectUris(undefined, false).ok).toBe(false);
    expect(parseRedirectUris([42], false).ok).toBe(false);
    expect(parseRedirectUris([null], false).ok).toBe(false);
    const many = Array.from({ length: MAX_REDIRECT_URIS + 1 }, (_, i) => `https://golf.example/${i}`);
    expect(parseRedirectUris(many, false).ok).toBe(false);
    expect(parseRedirectUris(many.slice(0, MAX_REDIRECT_URIS), false).ok).toBe(true);
    expect(parseRedirectUris([`https://golf.example/${"a".repeat(2100)}`], false).ok).toBe(false);
  });

  it("deduplicates and derives the allowed origins from the URIs themselves", () => {
    const parsed = parseRedirectUris(["https://a.example/x", "https://a.example/x", "https://a.example/y", "https://b.example/z"], false);
    expect(parsed).toEqual({ ok: true, value: { redirectUris: ["https://a.example/x", "https://a.example/y", "https://b.example/z"], allowedOrigins: ["https://a.example", "https://b.example"] } });
  });

  it("fuzz: whatever is accepted is exact, https (or dev loopback) and free of fragments, userinfo and wildcards", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)];
    const schemes = ["https://", "http://", "HTTPS://", "javascript:", "//", "", "https:/", "file://", "ftp://"];
    const users = ["", "", "", "u@", "u:p@", "@"];
    const hosts = ["golf.example", "localhost", "127.0.0.1", "[::1]", "*.golf.example", "golf.example.", "gölf.example", "a b.example", "xn--a.example", "0x7f.1", "evil.example\\@golf.example", "golf.example%00"];
    const ports = ["", ":443", ":8080", ":99999", ":abc", ":"];
    const paths = ["", "/", "/craft/auth/callback", "/a/../b", "/*", "/%2A", "/a#b", "/a b", "/\u0000", "?q=*", "?next=https://x", "/\t"];
    const tails = ["", "", "", "#", "#x", " ", "\n"];
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const uri = pick(schemes) + pick(users) + pick(hosts) + pick(ports) + pick(paths) + pick(tails);
      for (const production of [true, false]) {
        const result = parseRedirectUris([uri], production);
        if (!result.ok) continue;
        accepted++;
        const url = new URL(uri);
        expect(result.value.redirectUris).toEqual([uri]);
        expect(uri).not.toMatch(/[#*\s\\\u0000-\u001f]/);
        expect(url.username + url.password).toBe("");
        expect(url.hash).toBe("");
        expect(url.protocol === "https:" || (!production && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))).toBe(true);
        expect(result.value.allowedOrigins).toContain(url.origin);
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });
});

describe("other input validation", () => {
  it("emails are trimmed, lowercased and bounded", () => {
    expect(parseEmail("  Target@Example.COM ")).toEqual({ ok: true, value: "target@example.com" });
    for (const value of ["", "   ", "a", "a@b", "a b@c.de", "<a>@b.cd", "a@b.cd,e@f.gh", `${"a".repeat(250)}@b.cd`, 42, null, undefined, {}, ["a@b.cd"]]) {
      expect(parseEmail(value).ok, String(value)).toBe(false);
    }
  });

  it("roles accept exactly the four Craft roles", () => {
    for (const role of ["reader", "editor", "publisher", "admin"]) expect(parseCraftRole(role).ok).toBe(true);
    for (const role of ["owner", "super_admin", "Admin", " admin", "none", "", null, undefined, 1, {}, ["admin"]]) expect(parseCraftRole(role).ok, String(role)).toBe(false);
  });

  it("dataset names follow the Craft server rule", () => {
    for (const name of ["production", "staging-2", "a", "a_b", "0abc", "a".repeat(64)]) expect(parseDatasetName(name).ok, name).toBe(true);
    for (const name of ["", "Production", "-x", "_x", "a b", "a/b", "a".repeat(65), "é", 1, null, undefined]) expect(parseDatasetName(name).ok, String(name)).toBe(false);
  });

  it("client names are optional, bounded and printable", () => {
    expect(parseClientName(undefined, "Golf Lab Craft")).toEqual({ ok: true, value: "Golf Lab Craft" });
    expect(parseClientName("  Mine  ", "x")).toEqual({ ok: true, value: "Mine" });
    for (const name of ["", "   ", "a".repeat(81), "a\nb", "a\u0000b", 5, {}]) expect(parseClientName(name, "x").ok, String(name)).toBe(false);
  });

  it("status and key allow-lists", () => {
    expect(parseClientStatus("active").ok && parseClientStatus("disabled").ok).toBe(true);
    for (const value of ["", "ACTIVE", "deleted", null, undefined, 1]) expect(parseClientStatus(value).ok).toBe(false);
    expect(hasOnlyKeys({ a: 1 }, ["a", "b"])).toBe(true);
    expect(hasOnlyKeys({ a: 1, c: 2 }, ["a", "b"])).toBe(false);
    expect(hasOnlyKeys([], ["a"])).toBe(false);
    expect(hasOnlyKeys(null, ["a"])).toBe(false);
    expect(hasOnlyKeys({}, [])).toBe(true);
  });
});

describe("environment snippet", () => {
  it("lists the relying-party names from the design doc and never invents a secret", () => {
    const snippet = buildEnvSnippet({ issuer: "https://jongo.example", clientId: "jc_x", redirectUri: "https://golf.example/cb" });
    expect(snippet.split("\n")).toEqual([
      "CRAFT_SSO_ENABLED=true",
      "CRAFT_SSO_ISSUER=https://jongo.example",
      "CRAFT_SSO_CLIENT_ID=jc_x",
      `CRAFT_SSO_CLIENT_SECRET=${SECRET_PLACEHOLDER}`,
      "CRAFT_SSO_REDIRECT_URI=https://golf.example/cb"
    ]);
    expect(Object.values(CRAFT_RP_ENV)).toContain("CRAFT_SSO_CLIENT_SECRET");
  });

  it("includes the secret only when one is passed (the one-time reveal)", () => {
    expect(buildEnvSnippet({ issuer: null, clientId: "jc_x", redirectUri: null, secret: "jcs_abc" })).toContain("CRAFT_SSO_CLIENT_SECRET=jcs_abc");
    expect(buildEnvSnippet({ issuer: null, clientId: null, redirectUri: null })).not.toContain("jcs_");
  });
});

describe("panel helpers", () => {
  it("splits one URI per line", () => {
    expect(splitUriLines(" https://a.example/x \r\n\n  \nhttps://b.example/y\n")).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(formatDay("2026-11-06T23:59:00Z")).toBe("2026-11-06");
    expect(formatDay(null)).toBe("");
    expect(formatDay("nope")).toBe("");
  });
});
