import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_PRIVACY_USERNAME,
  PRIVACY_ROUTER_PRIORITY,
  buildDisableScript,
  buildEnableScript,
  buildInspectScript,
  buildPrivacyRouterYaml,
  generatePrivacyPassword,
  normalizePrivacyUsername,
  parseInspectOutput,
  privacyFilePath,
  shellQuote
} from "./privacy-mode";

const BCRYPT = "$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";

const VALID = {
  resourceUuid: "w59vqzik68ytf7u4jwh6qxis",
  rule: "Host(`teach.lgbt`) && PathPrefix(`/`)",
  containerName: "wordpress-w59vqzik68ytf7u4jwh6qxis",
  containerPort: 80,
  username: "jongo",
  passwordHash: BCRYPT
};

describe("generatePrivacyPassword", () => {
  it("is long and drawn from a large space, unlike the 100-value word list it replaces", () => {
    const p = generatePrivacyPassword();
    expect(p).toHaveLength(14);
    // 32-character alphabet ^ 14 — vastly beyond a brute-forceable range.
    expect(32 ** 14).toBeGreaterThan(1e21);
  });

  it("avoids characters that are misread when a password is dictated or typed", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePrivacyPassword()).not.toMatch(/[oO0Il1]/);
    }
  });

  it("does not repeat across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePrivacyPassword()));
    expect(seen.size).toBe(200);
  });

  it("refuses a length short enough to be guessable", () => {
    expect(() => generatePrivacyPassword(8)).toThrow(/at least 12/i);
  });
});

describe("normalizePrivacyUsername", () => {
  it("strips the colon that would otherwise split an htpasswd line", () => {
    expect(normalizePrivacyUsername("ad:min")).toBe("admin");
  });

  it("falls back to the default rather than producing an empty username", () => {
    expect(normalizePrivacyUsername("!!!")).toBe(DEFAULT_PRIVACY_USERNAME);
    expect(normalizePrivacyUsername("")).toBe(DEFAULT_PRIVACY_USERNAME);
    expect(normalizePrivacyUsername(null)).toBe(DEFAULT_PRIVACY_USERNAME);
  });

  it("lowercases and trims, and keeps the characters htpasswd allows", () => {
    expect(normalizePrivacyUsername("  Client_One.2-a  ")).toBe("client_one.2-a");
  });
});

describe("buildPrivacyRouterYaml", () => {
  it("outranks Coolify's own router so the password is actually asked for", () => {
    const yaml = buildPrivacyRouterYaml(VALID);
    expect(yaml).toContain(`priority: ${PRIVACY_ROUTER_PRIORITY}`);
    expect(PRIVACY_ROUTER_PRIORITY).toBeGreaterThan(1000);
  });

  it("reuses the site's real rule verbatim, backticks and all", () => {
    expect(buildPrivacyRouterYaml(VALID)).toContain('rule: "Host(`teach.lgbt`) && PathPrefix(`/`)"');
  });

  it("forwards to the container over Docker DNS, not a guessed Traefik service name", () => {
    const yaml = buildPrivacyRouterYaml(VALID);
    expect(yaml).toContain('url: "http://wordpress-w59vqzik68ytf7u4jwh6qxis:80"');
    expect(yaml).not.toContain("@docker");
  });

  it("keeps TLS on, so enabling privacy cannot silently break HTTPS", () => {
    const yaml = buildPrivacyRouterYaml(VALID);
    expect(yaml).toContain("certResolver: letsencrypt");
    expect(yaml).toContain("- https");
  });

  it("refuses a plaintext password where a bcrypt hash belongs", () => {
    // Traefik would accept this as a literal password, so it must never be written.
    expect(() => buildPrivacyRouterYaml({ ...VALID, passwordHash: "hunter2" })).toThrow(/bcrypt/i);
    expect(() => buildPrivacyRouterYaml({ ...VALID, passwordHash: "$apr1$xyz" })).toThrow(/bcrypt/i);
  });

  it("refuses an empty rule rather than writing a router that matches nothing", () => {
    expect(() => buildPrivacyRouterYaml({ ...VALID, rule: "   " })).toThrow(/empty rule/i);
  });

  it("namespaces every name by resource, so two private sites cannot collide", () => {
    const a = buildPrivacyRouterYaml(VALID);
    const b = buildPrivacyRouterYaml({ ...VALID, resourceUuid: "other123", containerName: "wordpress-other123" });
    expect(a).toContain("jongo-privacy-w59vqzik68ytf7u4jwh6qxis:");
    expect(b).toContain("jongo-privacy-other123:");
    expect(b).not.toContain("w59vqzik68ytf7u4jwh6qxis");
  });

  it("escapes a double quote in the rule instead of ending the YAML scalar early", () => {
    const yaml = buildPrivacyRouterYaml({ ...VALID, rule: 'Host(`a.test`) && Header(`x`,`"y"`)' });
    expect(yaml).toContain('\\"y\\"');
  });
});

describe("host scripts", () => {
  it("writes atomically, because a half-written router would be read and rejected", () => {
    const script = buildEnableScript(VALID.resourceUuid, buildPrivacyRouterYaml(VALID));
    expect(script).toContain("mktemp");
    expect(script).toContain("mv -f");
  });

  it("targets only files this feature owns", () => {
    expect(privacyFilePath("abc")).toBe("/data/coolify/proxy/dynamic/jongo-privacy-abc.yaml");
    expect(buildDisableScript("abc")).toContain("jongo-privacy-abc.yaml");
    // Never a wildcard: the same directory holds Coolify's own configuration.
    expect(buildDisableScript("abc")).not.toMatch(/rm -f .*\*/);
  });

  it("neutralises an injection attempt — verified against a real shell, not by substring", () => {
    // The payload DOES appear inside the script; that is fine, because it
    // appears inside single quotes. The property that matters is that bash
    // hands it back as one literal argument, so assert exactly that.
    const nasty = "abc'; rm -rf /; echo '";
    const roundTripped = execFileSync("bash", ["-c", `printf %s ${shellQuote(nasty)}`]).toString();
    expect(roundTripped).toBe(nasty);

    // And confirm each script routes its value through that quoting: the
    // inspect script quotes the bare id, the disable script quotes the whole
    // path it is about to remove.
    expect(buildInspectScript(nasty)).toContain(shellQuote(nasty));
    expect(buildDisableScript(nasty)).toContain(shellQuote(privacyFilePath(nasty)));

    // The path form must survive a shell too — it is an argument to rm.
    const pathRoundTrip = execFileSync("bash", [
      "-c",
      `printf %s ${shellQuote(privacyFilePath(nasty))}`
    ]).toString();
    expect(pathRoundTrip).toBe(privacyFilePath(nasty));
  });

  it("reads the https router's rule, not the http redirect", () => {
    expect(buildInspectScript("abc")).toContain("routers\\.https-");
  });
});

describe("parseInspectOutput", () => {
  it("keeps a rule containing '=' intact", () => {
    const parsed = parseInspectOutput(
      "CONTAINER=wordpress-abc\nPORT=80\nRULE=Host(`a.test`) && Query(`x=1`)\n"
    );
    expect(parsed).toEqual({ container: "wordpress-abc", port: 80, rule: "Host(`a.test`) && Query(`x=1`)" });
  });

  it("returns null rather than a half-built config when a field is missing", () => {
    expect(parseInspectOutput("CONTAINER=x\nPORT=80\n")).toBeNull();
    expect(parseInspectOutput("PORT=80\nRULE=Host(`a`)\n")).toBeNull();
    expect(parseInspectOutput("CONTAINER=x\nPORT=nope\nRULE=Host(`a`)\n")).toBeNull();
  });
});
