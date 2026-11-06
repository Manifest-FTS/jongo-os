import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);
const sql = readFileSync(new URL("prisma/migrations/20261106120000_oidc_provider_site_craft_access/migration.sql", root), "utf8");
const NEW_TABLES = ["OidcClient", "OidcAuthCode", "OidcConsent", "SiteCraftAccess"];
// Referential actions on the new tables' own foreign keys are not data statements.
const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
  .replace(/ON (?:DELETE|UPDATE) (?:CASCADE|RESTRICT|SET NULL)/g, "");

describe("OIDC migration is additive only", () => {
  it("contains no destructive or rewriting statement", () => {
    for (const forbidden of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bDISABLE\b/i, /ALTER\s+TYPE/i, /ALTER\s+COLUMN/i, /ADD\s+COLUMN/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("only creates new tables, enums and indexes on new tables", () => {
    expect([...code.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    expect([...code.matchAll(/CREATE TYPE "(\w+)"/g)].map((m) => m[1]).sort()).toEqual(["OidcClientStatus", "SiteCraftRole"]);
    for (const m of code.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "(\w+)"/g)) expect(NEW_TABLES).toContain(m[1]);
  });

  it("only ALTERs new tables (to add their own foreign keys)", () => {
    const alters = [...code.matchAll(/ALTER TABLE "(\w+)" (\w+ \w+)/g)];
    expect(alters.length).toBeGreaterThan(0);
    for (const m of alters) {
      expect(NEW_TABLES, m[0]).toContain(m[1]);
      expect(m[2]).toBe("ADD CONSTRAINT");
    }
  });

  it("references existing tables only through foreign keys", () => {
    const references = [...code.matchAll(/REFERENCES "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(references)).toEqual(new Set(["Site", "User", "OidcClient"]));
  });

  it("defines the unique-active constraint and is wrapped in a transaction", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX "SiteCraftAccess_active_siteId_userId_key" ON "SiteCraftAccess"\("siteId", "userId"\) WHERE "revokedAt" IS NULL/);
    expect(code.trim().startsWith("BEGIN;")).toBe(true);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
  });
});

describe("schema additions", () => {
  const schema = readFileSync(new URL("prisma/schema.prisma", root), "utf8");
  it("declares the new models", () => {
    for (const model of NEW_TABLES) expect(schema).toMatch(new RegExp(`^model ${model} \\{`, "m"));
    expect(schema).toMatch(/^enum OidcClientStatus \{/m);
    expect(schema).toMatch(/^enum SiteCraftRole \{/m);
  });
  it("adds only virtual relation fields to User and Site", () => {
    const user = /^model User \{[\s\S]*?^\}/m.exec(schema)![0];
    const site = /^model Site \{[\s\S]*?^\}/m.exec(schema)![0];
    for (const field of ["oidcClientsCreated OidcClient[]", "oidcAuthCodes OidcAuthCode[]", "oidcConsents OidcConsent[]", "siteCraftAccess SiteCraftAccess[]", "siteCraftAccessGranted SiteCraftAccess[]"]) {
      expect(user).toContain(field);
    }
    for (const field of ["oidcClients              OidcClient[]", "craftAccess              SiteCraftAccess[]"]) expect(site).toContain(field);
  });
});
