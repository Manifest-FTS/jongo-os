import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);
const sql = readFileSync(new URL("prisma/migrations/20261107120000_invitation_craft_access/migration.sql", root), "utf8");
const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
  .replace(/ON (?:DELETE|UPDATE) (?:CASCADE|RESTRICT|SET NULL)/g, "");

describe("invitation Craft access migration is additive only", () => {
  it("creates one new table and never alters Invitation", () => {
    for (const forbidden of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bRENAME\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /ALTER\s+TYPE/i, /ALTER\s+COLUMN/i, /ADD\s+COLUMN/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    expect([...code.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(["InvitationCraftAccess"]);
    expect([...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(["InvitationCraftAccess"]);
    expect([...code.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "(\w+)"/g)].map((m) => m[1])).toEqual(["InvitationCraftAccess"]);
    expect([...code.matchAll(/REFERENCES "(\w+)"/g)].map((m) => m[1])).toEqual(["Invitation"]);
    expect(code.trim().startsWith("BEGIN;")).toBe(true);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("schema.prisma adds only a virtual relation to Invitation", () => {
    const schema = readFileSync(new URL("prisma/schema.prisma", root), "utf8");
    const invitation = /^model Invitation \{[\s\S]*?^\}/m.exec(schema)![0];
    expect(invitation).toContain("craftAccess    InvitationCraftAccess?");
    expect(schema).toMatch(/^model InvitationCraftAccess \{/m);
  });
});
