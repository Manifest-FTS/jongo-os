#!/usr/bin/env node
/**
 * create-admin.mjs
 *
 * Create or update the first admin user in the database.
 * Reads DATABASE_URL from environment, .env, or .env.local.
 *
 * Usage:
 *   node scripts/create-admin.mjs --email admin@example.com --password changeme
 *   npm run create-admin -- --email admin@example.com --password changeme
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ── Load .env files (prefer .env.local, fall back to .env) ────────────────
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

loadEnvFile(resolve(repoRoot, ".env.local"));
loadEnvFile(resolve(repoRoot, ".env"));

// ── Parse CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const email = getArg("email");
const password = getArg("password");

if (!email || !password) {
  console.error("Usage: node scripts/create-admin.mjs --email <email> --password <password>");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add it to .env.local or set it in the environment.");
  process.exit(1);
}

// ── Hash password and upsert user ──────────────────────────────────────────
// bcryptjs is hoisted to the workspace root; @prisma/client lives in apps/web
const { hashSync } = await import("bcryptjs");
const prismaClientPath = resolve(repoRoot, "apps/web/node_modules/@prisma/client/index.js");
const { PrismaClient } = await import(prismaClientPath);

const db = new PrismaClient();

try {
  const passwordHash = hashSync(password, 12);

  const user = await db.user.upsert({
    where: { email },
    create: {
      email,
      fullName: email.split("@")[0],
      passwordHash,
      emailVerified: true,
      authProvider: "local"
    },
    update: {
      passwordHash,
      emailVerified: true,
      authProvider: "local"
    }
  });

  console.log(`\n✓ Admin user ready:`);
  console.log(`  Email:  ${user.email}`);
  console.log(`  ID:     ${user.id}`);
  console.log(`  Action: ${user.createdAt.getTime() === user.updatedAt.getTime() ? "created" : "updated"}\n`);
} catch (err) {
  console.error("Failed to create user:", err.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
