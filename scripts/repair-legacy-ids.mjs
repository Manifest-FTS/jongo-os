#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

const prisma = new PrismaClient();
const UUID_REGEX = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const APPLY = process.argv.includes("--apply");

const TABLES = [
  "User",
  "Organization",
  "Site",
  "Environment",
  "Deployment",
  "Collaborator",
  "SiteCollaborator",
  "ApiToken",
  "AuditLog"
];

const FK_MAP = {
  User: [
    ["Organization", "ownerId"],
    ["Collaborator", "userId"],
    ["Collaborator", "grantedById"],
    ["SiteCollaborator", "userId"],
    ["ApiToken", "userId"],
    ["AuditLog", "actorId"],
    ["Deployment", "triggeredById"]
  ],
  Organization: [
    ["Site", "organizationId"],
    ["Collaborator", "organizationId"],
    ["ApiToken", "organizationId"],
    ["AuditLog", "organizationId"]
  ],
  Site: [
    ["Environment", "siteId"],
    ["SiteCollaborator", "siteId"]
  ],
  Environment: [["Deployment", "environmentId"]],
  Deployment: [],
  Collaborator: [],
  SiteCollaborator: [],
  ApiToken: [],
  AuditLog: []
};

function safeTmpName(tableName) {
  return `tmp_id_map_${tableName.toLowerCase()}`;
}

async function loadColumnTypes() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('User','Organization','Site','Environment','Deployment','Collaborator','SiteCollaborator','ApiToken','AuditLog')
      AND column_name IN ('id','ownerId','organizationId','siteId','environmentId','triggeredById','userId','grantedById','actorId')
  `);

  const typeMap = new Map();
  for (const row of rows) {
    typeMap.set(`${row.table_name}.${row.column_name}`, row.data_type === "uuid" || row.udt_name === "uuid" ? "uuid" : "text");
  }
  return typeMap;
}

async function collectInvalidPrimaryKeys(typeMap) {
  const findings = [];

  for (const tableName of TABLES) {
    const idType = typeMap.get(`${tableName}.id`);
    if (idType !== "text") {
      continue;
    }

    const invalidRows = await prisma.$queryRawUnsafe(
      `SELECT id::text AS id FROM "${tableName}" WHERE id IS NOT NULL AND NOT (id::text ~* '${UUID_REGEX}') LIMIT 50`
    );

    if (invalidRows.length === 0) {
      continue;
    }

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM "${tableName}" WHERE id IS NOT NULL AND NOT (id::text ~* '${UUID_REGEX}')`
    );

    findings.push({
      tableName,
      count: countRows[0].count,
      sampleIds: invalidRows.map((r) => r.id)
    });
  }

  return findings;
}

async function applyRepair(typeMap, findings) {
  await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");

  await prisma.$transaction(async (tx) => {
    for (const finding of findings) {
      const tableName = finding.tableName;
      const tmpTable = safeTmpName(tableName);

      await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tmpTable}"`);
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE "${tmpTable}" (
          old_id TEXT PRIMARY KEY,
          new_id UUID NOT NULL
        ) ON COMMIT DROP
      `);

      await tx.$executeRawUnsafe(`
        INSERT INTO "${tmpTable}" (old_id, new_id)
        SELECT id::text, gen_random_uuid()
        FROM "${tableName}"
        WHERE id IS NOT NULL AND NOT (id::text ~* '${UUID_REGEX}')
      `);

      await tx.$executeRawUnsafe(`
        UPDATE "${tableName}" t
        SET "id" = m.new_id::text
        FROM "${tmpTable}" m
        WHERE t.id::text = m.old_id
      `);

      for (const [refTable, refColumn] of FK_MAP[tableName]) {
        const refType = typeMap.get(`${refTable}.${refColumn}`);
        if (refType !== "text") {
          continue;
        }

        await tx.$executeRawUnsafe(`
          UPDATE "${refTable}" r
          SET "${refColumn}" = m.new_id::text
          FROM "${tmpTable}" m
          WHERE r."${refColumn}"::text = m.old_id
        `);
      }
    }
  });
}

(async () => {
  try {
    const typeMap = await loadColumnTypes();
    const findings = await collectInvalidPrimaryKeys(typeMap);

    console.log("UUID_COLUMN_MODELS", TABLES);

    if (findings.length === 0) {
      console.log("No legacy text primary keys detected in UUID-modeled tables. No repair required.");
      return;
    }

    console.log("LEGACY_ID_FINDINGS", JSON.stringify(findings, null, 2));

    if (!APPLY) {
      console.log("Dry-run only. Re-run with --apply to rewrite legacy text ids to generated UUIDs and update text FK columns.");
      process.exitCode = 2;
      return;
    }

    await applyRepair(typeMap, findings);
    console.log("Repair completed. Legacy text ids were rewritten to UUIDs with FK updates in one transaction.");
  } finally {
    await prisma.$disconnect();
  }
})().catch(async (error) => {
  console.error("Repair failed", error);
  try {
    await prisma.$disconnect();
  } catch {
    // noop
  }
  process.exit(1);
});
