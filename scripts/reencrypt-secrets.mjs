#!/usr/bin/env node
/**
 * Re-encrypt stored secrets with SECRETS_ENCRYPTION_KEY.
 *
 * Upgrades legacy v1 values (keyed off NEXTAUTH_SECRET) and v2 values written
 * with SECRETS_ENCRYPTION_KEY_PREVIOUS to v2 under the current key, so the old
 * secret can be retired. Dry run by default; pass --apply to write.
 *
 *   node scripts/reencrypt-secrets.mjs            # report only
 *   node scripts/reencrypt-secrets.mjs --apply    # rewrite
 *
 * Self-contained because the production image ships scripts/ but not
 * apps/web/src. The format MUST match apps/web/src/lib/secret-box.ts;
 * secret-box-format.test.ts checks both directions.
 *
 * Prints counts and row ids only — never secret values.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const ALGORITHM = "aes-256-gcm";

export const TARGETS = [
  { model: "githubAppConfig", columns: ["clientSecretEnc", "webhookSecretEnc", "privateKeyEnc"] },
  { model: "wordPressTelemetryConfig", columns: ["passwordCiphertext"] }
];

export function parseKey(raw, name = "SECRETS_ENCRYPTION_KEY") {
  const value = String(raw).trim();
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 random bytes, as base64 or 64 hex characters.`);
  return key;
}

export function keyId(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function loadKeys(env = process.env) {
  if (!env.SECRETS_ENCRYPTION_KEY?.trim()) throw new Error("SECRETS_ENCRYPTION_KEY is not set.");
  const current = parseKey(env.SECRETS_ENCRYPTION_KEY);
  const byId = new Map([[keyId(current), current]]);
  if (env.SECRETS_ENCRYPTION_KEY_PREVIOUS?.trim()) {
    const previous = parseKey(env.SECRETS_ENCRYPTION_KEY_PREVIOUS, "SECRETS_ENCRYPTION_KEY_PREVIOUS");
    byId.set(keyId(previous), previous);
  }
  const legacySecret = env.WORDPRESS_TELEMETRY_ENCRYPTION_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim() || "";
  const legacy = legacySecret ? createHash("sha256").update(legacySecret).digest() : null;
  return { current, currentId: keyId(current), byId, legacy };
}

export function decrypt(payload, keys) {
  const parts = String(payload).split(":");
  let key;
  let iv;
  let tag;
  let data;
  if (parts[0] === "v2" && parts.length === 5) {
    key = keys.byId.get(parts[1]);
    if (!key) throw new Error(`no configured key for key id ${parts[1]}`);
    [, , iv, tag, data] = parts;
  } else if (parts[0] === "v1" && parts.length === 4) {
    key = keys.legacy;
    if (!key) throw new Error("legacy value but no NEXTAUTH_SECRET / WORDPRESS_TELEMETRY_ENCRYPTION_SECRET");
    [, iv, tag, data] = parts;
  } else {
    throw new Error("unsupported format");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function encrypt(plaintext, keys) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keys.current, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", keys.currentId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function isCurrent(payload, keys) {
  const parts = String(payload).split(":");
  return parts[0] === "v2" && parts[1] === keys.currentId;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const keys = loadKeys();
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  let pending = 0;
  let rewritten = 0;
  let failed = 0;

  try {
    for (const { model, columns } of TARGETS) {
      const rows = await db[model].findMany({ select: { id: true, ...Object.fromEntries(columns.map((c) => [c, true])) } });
      for (const row of rows) {
        for (const column of columns) {
          const value = row[column];
          if (!value || isCurrent(value, keys)) continue;
          pending += 1;
          let next;
          try {
            next = encrypt(decrypt(value, keys), keys);
          } catch (error) {
            failed += 1;
            console.error(`[reencrypt] ${model}.${column} id=${row.id}: cannot decrypt (${error.message})`);
            continue;
          }
          if (!apply) continue;
          // Compare-and-set: skip if the app rewrote the value meanwhile.
          const result = await db[model].updateMany({ where: { id: row.id, [column]: value }, data: { [column]: next } });
          rewritten += result.count;
        }
      }
    }
  } finally {
    await db.$disconnect();
  }

  console.log(
    apply
      ? `[reencrypt] rewritten ${rewritten} of ${pending} value(s); ${failed} could not be decrypted.`
      : `[reencrypt] dry run: ${pending} value(s) need re-encryption; ${failed} could not be decrypted. Re-run with --apply.`
  );
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[reencrypt] ${error.message}`);
    process.exit(1);
  });
}
