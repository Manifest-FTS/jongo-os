/**
 * Operator tool (read-only): why can this person not "Sign in with Jongo" to an app's Craft studio?
 *
 *   node scripts/oidc-diagnose.mjs --email person@example.com (--client-id jc_xxx | --site-id <uuid>) \
 *       [--redirect-uri https://site/craft/auth/callback] [--dataset production]
 *
 * Run it inside the Jongo app container so the flags it reports are the ones the running app sees, with DATABASE_URL set.
 * Prints PASS/FAIL per check and names only: never secrets, hashes, keys or connection strings. Writes nothing.
 */
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const set = value => typeof value === "string" && value.trim() !== "";

/** Returns [{ name, ok, detail }]. `prisma` and `env` are injected so tests need no database. */
export async function diagnose(prisma, { email, clientId, siteId, redirectUri, dataset }, env = process.env) {
  const out = [];
  const check = (name, ok, detail = "") => { out.push({ name, ok, detail }); return ok; };

  check("JONGO_OIDC_ENABLED is exactly \"true\" (else /oidc/authorize is 404)", env.JONGO_OIDC_ENABLED === "true", env.JONGO_OIDC_ENABLED === "true" ? "" : "set it, then redeploy");
  check("JONGO_CMS_ENABLED is exactly \"true\" (else no one, platform admins included, is authorized)", env.JONGO_CMS_ENABLED === "true", env.JONGO_CMS_ENABLED === "true" ? "" : "set it, then redeploy");
  for (const name of ["JONGO_OIDC_ISSUER", "JONGO_OIDC_SIGNING_KEY", "JONGO_OIDC_SIGNING_KID", "NEXTAUTH_SECRET"]) check(`${name} is set`, set(env[name]));

  let client = null;
  try {
    client = await prisma.oidcClient.findFirst({
      where: clientId ? { clientId } : { siteId, status: "active" },
      select: { id: true, clientId: true, siteId: true, organizationId: true, status: true, datasetName: true, redirectUris: true, allowedOrigins: true }
    });
  } catch {
    check("OIDC tables exist (migration 20261106120000 applied)", false, "the query failed; run prisma migrate deploy");
    return out;
  }
  check("OIDC tables exist (migration 20261106120000 applied)", true);
  if (!check("a registered client exists for the app", Boolean(client), "register one with scripts/oidc-register-client.mjs register")) return out;
  check("client is active", client.status === "active", `status is ${client.status}`);
  if (redirectUri) check("the site's redirect URI is registered EXACTLY", client.redirectUris.includes(redirectUri), `registered: ${client.redirectUris.join(", ")}`);
  if (dataset) check("client dataset name equals the site's JONGO_CRAFT_DATASET", client.datasetName === dataset, `client has "${client.datasetName}"`);

  const site = await prisma.site.findUnique({
    where: { id: client.siteId },
    select: { id: true, deletedAt: true, organization: { select: { id: true, ownerId: true, deletedAt: true, owner: { select: { id: true, deletedAt: true } } } } }
  });
  const org = site?.organization ?? null;
  check("the app exists and is not deleted", Boolean(site) && !site.deletedAt);
  check("its client (organization) exists and is not deleted", Boolean(org) && !org.deletedAt);
  check("the organization owner exists and is not deleted (needed for the read entitlement)", Boolean(org?.owner) && !org.owner.deletedAt && org.owner.id === org.ownerId);

  const user = await prisma.user.findFirst({
    where: { email: { equals: String(email ?? "").trim(), mode: "insensitive" } },
    select: { id: true, deletedAt: true, emailVerified: true, authProvider: true }
  });
  if (!check("the person has a Jongo account", Boolean(user))) return out;
  check("the account is not deleted", !user.deletedAt);
  const platformAdmin = await prisma.platformAdmin.findUnique({ where: { userId: user.id }, select: { id: true } });
  const grant = site ? await prisma.siteCraftAccess.findFirst({ where: { siteId: site.id, userId: user.id, revokedAt: null }, select: { role: true } }) : null;
  const orgMember = org ? await prisma.collaborator.findFirst({ where: { organizationId: org.id, userId: user.id, deletedAt: null }, select: { role: true } }) : null;
  const how = platformAdmin ? "platform admin" : org?.ownerId === user.id ? "owner" : orgMember?.role === "admin" ? "client admin" : grant ? `site grant (${grant.role})` : null;
  check("the person has some Craft access to this app", how !== null, how ?? "no platform-admin row, not owner or client admin, no active site grant");
  check("the Jongo account's email is verified (the site rejects the sign-in otherwise)", user.emailVerified === true, user.emailVerified === true ? "" : "emailVerified is false; verify the address (see docs/craft-sso-design.md) or the Golf Lab will refuse the token");

  const recent = await prisma.auditLog.findMany({
    where: { organizationId: client.organizationId, OR: [{ action: { startsWith: "oidc." } }, { action: { startsWith: "craft.access" } }] },
    orderBy: { createdAt: "desc" }, take: 8, select: { action: true, createdAt: true }
  });
  out.push({ name: "recent oidc/craft audit actions", ok: true, detail: recent.map(row => `${row.createdAt.toISOString()} ${row.action}`).join("; ") || "none" });
  return out;
}

function parseArgs(argv) {
  const out = {};
  const keys = { "--email": "email", "--client-id": "clientId", "--site-id": "siteId", "--redirect-uri": "redirectUri", "--dataset": "dataset" };
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]];
    if (!key) throw new Error(`unknown argument ${argv[i]}`);
    const value = argv[++i];
    if (!value) throw new Error(`${argv[i - 1]} requires a value`);
    out[key] = value;
  }
  if (!out.email) throw new Error("--email is required");
  if (!out.clientId && !(out.siteId && UUID.test(out.siteId))) throw new Error("provide --client-id or a valid --site-id");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const results = await diagnose(prisma, args);
    for (const row of results) console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}${row.detail ? ` -- ${row.detail}` : ""}`);
    process.exitCode = results.some(row => !row.ok) ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`error: ${error.message}`); process.exit(2); });
}
