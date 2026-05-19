#!/usr/bin/env node
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(resolve(repoRoot, "apps/web/.env.local"));
loadEnvFile(resolve(repoRoot, ".env.local"));
loadEnvFile(resolve(repoRoot, ".env"));

const { default: pg } = await import("pg");
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const res = await client.query(
  `SELECT id, email, "fullName", "authProvider", "createdAt", "passwordHash" IS NOT NULL as has_password
   FROM "User" ORDER BY "createdAt" ASC`
);

console.log("\n=== Users in database ===");
if (res.rows.length === 0) {
  console.log("No users found.");
} else {
  res.rows.forEach((u) => {
    console.log(`  ${u.email} | has_password=${u.has_password} | provider=${u.authProvider ?? "null"} | created=${u.createdAt?.toISOString?.() ?? u.createdAt}`);
  });
}
console.log(`\nTotal: ${res.rows.length} user(s)\n`);

await client.end();
