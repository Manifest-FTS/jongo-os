/**
 * Operator tool: register or rotate the "Sign in with Jongo" client for ONE app (Site).
 *
 *   node scripts/oidc-register-client.mjs register --site-id <uuid> --name "Golf Lab Craft" \
 *       --redirect-uri https://example.com/craft/auth/callback [--redirect-uri ...] [--dataset production] [--created-by <user uuid>]
 *   node scripts/oidc-register-client.mjs rotate --client-id jc_xxxxxxxxxxxxxxxxxxxxxx   (old secret stays valid 24 h)
 *   node scripts/oidc-register-client.mjs disable --client-id jc_xxxxxxxxxxxxxxxxxxxxxx
 *
 * Uses DATABASE_URL from the environment of the process (never read from a file by this script). The client secret
 * is printed exactly once and stored only as a salted hash. Redirect URIs must be https (loopback http outside
 * production), with no fragment, userinfo or wildcard; allowed origins are derived from them.
 * Also writes an AuditLog row. Exact-match redirect semantics are enforced by the server, not here.
 */
import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROTATION_OVERLAP_MS = 24 * 3600_000;

export const generateClientId = () => `jc_${randomBytes(16).toString("base64url")}`;
export const generateClientSecret = () => `jcs_${randomBytes(32).toString("base64url")}`;

/** Same "v1$<salt>$<hash>" format as apps/web/src/lib/oidc/clients.ts (covered by a cross-check test). */
export function hashClientSecret(secret) {
  const salt = randomBytes(16);
  return `v1$${salt.toString("base64url")}$${createHmac("sha256", salt).update(secret, "utf8").digest().toString("base64url")}`;
}

const isLoopback = host => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

export function checkRedirectUri(uri, production) {
  if (!uri || uri.length > 2048 || /[\s*\u0000-\u001f\\#]/.test(uri)) return "malformed, fragment or wildcard";
  let url;
  try { url = new URL(uri); } catch { return "not a URL"; }
  if (url.username || url.password) return "userinfo not allowed";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && !production && isLoopback(url.hostname)))) return "must be https";
  return null;
}

export async function registerClient(prisma, { siteId, name, redirectUris, datasetName = "production", createdById = null, production = true }) {
  if (!UUID.test(siteId)) throw new Error("--site-id must be a UUID");
  if (!name?.trim()) throw new Error("--name is required");
  if (!redirectUris?.length) throw new Error("at least one --redirect-uri is required");
  for (const uri of redirectUris) {
    const problem = checkRedirectUri(uri, production);
    if (problem) throw new Error(`redirect URI rejected (${problem})`);
  }
  const allowedOrigins = [...new Set(redirectUris.map(uri => new URL(uri).origin))];
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, organizationId: true, deletedAt: true } });
  if (!site || site.deletedAt) throw new Error("site not found");

  const clientId = generateClientId();
  const secret = generateClientSecret();
  const created = await prisma.$transaction(async tx => {
    const row = await tx.oidcClient.create({
      data: { clientId, organizationId: site.organizationId, siteId, name: name.trim(), datasetName, secretHash: hashClientSecret(secret), redirectUris, allowedOrigins, createdById },
      select: { id: true }
    });
    await tx.auditLog.create({ data: { organizationId: site.organizationId, actorId: createdById, action: "oidc.client.create", resourceType: "oidc_client", resourceId: row.id, details: { clientId, siteId } } });
    return row;
  });
  return { id: created.id, clientId, secret };
}

export async function rotateClientSecret(prisma, clientId, now = new Date()) {
  const secret = generateClientSecret();
  const client = await prisma.oidcClient.findUnique({ where: { clientId }, select: { id: true, organizationId: true, secretHash: true, status: true } });
  if (!client || client.status !== "active") throw new Error("client not found or disabled");
  await prisma.$transaction(async tx => {
    await tx.oidcClient.update({
      where: { id: client.id },
      data: { secretHash: hashClientSecret(secret), previousSecretHash: client.secretHash, previousSecretExpiresAt: new Date(now.getTime() + ROTATION_OVERLAP_MS), rotatedAt: now }
    });
    await tx.auditLog.create({ data: { organizationId: client.organizationId, actorId: null, action: "oidc.client.rotate", resourceType: "oidc_client", resourceId: client.id, details: { clientId } } });
  });
  return { clientId, secret };
}

export async function disableClient(prisma, clientId, now = new Date()) {
  const client = await prisma.oidcClient.findUnique({ where: { clientId }, select: { id: true, organizationId: true } });
  if (!client) throw new Error("client not found");
  await prisma.$transaction(async tx => {
    await tx.oidcClient.update({ where: { id: client.id }, data: { status: "disabled", disabledAt: now, previousSecretHash: null, previousSecretExpiresAt: null } });
    await tx.auditLog.create({ data: { organizationId: client.organizationId, actorId: null, action: "oidc.client.disable", resourceType: "oidc_client", resourceId: client.id, details: { clientId } } });
  });
}

function parseArgs(argv) {
  const out = { redirectUris: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (!next) throw new Error(`${arg} requires a value`); return next; };
    if (arg === "--site-id") out.siteId = value();
    else if (arg === "--name") out.name = value();
    else if (arg === "--redirect-uri") out.redirectUris.push(value());
    else if (arg === "--dataset") out.datasetName = value();
    else if (arg === "--created-by") out.createdById = value();
    else if (arg === "--client-id") out.clientId = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    if (command === "register") {
      const result = await registerClient(prisma, { ...args, production: process.env.NODE_ENV === "production" });
      console.log(`client_id:     ${result.clientId}\nclient_secret: ${result.secret}\n(the secret is shown once; store it in the site's secret store)`);
    } else if (command === "rotate") {
      const result = await rotateClientSecret(prisma, args.clientId);
      console.log(`client_id:     ${result.clientId}\nclient_secret: ${result.secret}\n(the previous secret keeps working for 24 hours)`);
    } else if (command === "disable") {
      await disableClient(prisma, args.clientId);
      console.log("disabled");
    } else {
      console.error("usage: oidc-register-client.mjs register|rotate|disable ... (see the header of this file)");
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`error: ${error.message}`); process.exit(1); });
}
