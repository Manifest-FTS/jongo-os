import { getDb } from "@/lib/db";
import { generateClientId, generateClientSecret, hashClientSecret } from "@/lib/oidc/clients";
import { writeOidcAudit } from "@/lib/oidc/audit";

/** Same overlap as scripts/oidc-register-client.mjs: the previous secret keeps working for 24 hours after rotation. */
export const ROTATION_OVERLAP_MS = 24 * 3600_000;

/** What the dashboard may see. Deliberately has no secret, no hash and no previous hash. */
export type CraftClientView = {
  clientId: string;
  name: string;
  datasetName: string;
  status: "active" | "disabled";
  redirectUris: string[];
  allowedOrigins: string[];
  createdAt: Date;
  rotatedAt: Date | null;
  disabledAt: Date | null;
  /** Set only while the previous secret is still accepted. */
  previousSecretValidUntil: Date | null;
};

const VIEW_SELECT = {
  id: true, clientId: true, name: true, datasetName: true, status: true, redirectUris: true, allowedOrigins: true,
  createdAt: true, rotatedAt: true, disabledAt: true, previousSecretExpiresAt: true
} as const;

type Row = {
  id: string; clientId: string; name: string; datasetName: string; status: string; redirectUris: string[]; allowedOrigins: string[];
  createdAt: Date; rotatedAt: Date | null; disabledAt: Date | null; previousSecretExpiresAt: Date | null;
};

export function toClientView(row: Row, now: Date = new Date()): CraftClientView {
  return {
    clientId: row.clientId, name: row.name, datasetName: row.datasetName,
    status: row.status === "disabled" ? "disabled" : "active",
    redirectUris: [...row.redirectUris], allowedOrigins: [...row.allowedOrigins],
    createdAt: row.createdAt, rotatedAt: row.rotatedAt, disabledAt: row.disabledAt,
    previousSecretValidUntil: row.previousSecretExpiresAt && row.previousSecretExpiresAt.getTime() > now.getTime() ? row.previousSecretExpiresAt : null
  };
}

export type ClientFailure = { ok: false; reason: "not_found" | "conflict" | "unavailable"; message?: string };
type Site = { id: string; organizationId: string };
type Audit = { actorId: string; ipAddress?: string | null; userAgent?: string | null };

/** Serializes writers for one site so "one client per site" holds under concurrent creates. */
async function lockSite(tx: any, siteId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${siteId}, 0))`;
}

export async function getCraftClient(site: Site): Promise<{ ok: true; client: CraftClientView | null } | ClientFailure> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    const row = await db.oidcClient.findFirst({ where: { siteId: site.id, organizationId: site.organizationId }, orderBy: { createdAt: "asc" }, select: VIEW_SELECT });
    return { ok: true, client: row ? toClientView(row) : null };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type CreateClientInput = Audit & {
  site: Site; name: string; datasetName: string; redirectUris: string[]; allowedOrigins: string[];
};

/** The plaintext secret exists only in this return value; it is hashed before storage and never logged. */
export async function createCraftClient(input: CreateClientInput): Promise<{ ok: true; client: CraftClientView; secret: string } | ClientFailure> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    return await db.$transaction(async (tx: any) => {
      await lockSite(tx, input.site.id);
      const site = await tx.site.findFirst({ where: { id: input.site.id, organizationId: input.site.organizationId, deletedAt: null }, select: { id: true } });
      if (!site) return { ok: false as const, reason: "not_found" as const };
      const existing = await tx.oidcClient.findFirst({ where: { siteId: input.site.id }, select: { id: true } });
      if (existing) return { ok: false as const, reason: "conflict" as const, message: "This app already has a Craft client. Update, rotate or enable it instead." };
      const clientId = generateClientId();
      const secret = generateClientSecret();
      const row: Row = await tx.oidcClient.create({
        data: {
          clientId, organizationId: input.site.organizationId, siteId: input.site.id, name: input.name, datasetName: input.datasetName,
          secretHash: hashClientSecret(secret), redirectUris: input.redirectUris, allowedOrigins: input.allowedOrigins, createdById: input.actorId
        },
        select: VIEW_SELECT
      });
      await writeOidcAudit(tx, {
        organizationId: input.site.organizationId, actorId: input.actorId, action: "oidc.client.create", resourceType: "oidc_client", resourceId: row.id,
        details: { clientId, siteId: input.site.id, datasetName: input.datasetName, redirectUriCount: input.redirectUris.length },
        ipAddress: input.ipAddress, userAgent: input.userAgent
      });
      return { ok: true as const, client: toClientView(row), secret };
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type UpdateClientInput = Audit & {
  site: Site;
  redirectUris?: { redirectUris: string[]; allowedOrigins: string[] };
  datasetName?: string;
  status?: "active" | "disabled";
};

export async function updateCraftClient(input: UpdateClientInput, now: Date = new Date()): Promise<{ ok: true; client: CraftClientView } | ClientFailure> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    return await db.$transaction(async (tx: any) => {
      await lockSite(tx, input.site.id);
      const current = await tx.oidcClient.findFirst({
        where: { siteId: input.site.id, organizationId: input.site.organizationId },
        orderBy: { createdAt: "asc" }, select: { id: true, clientId: true, status: true }
      });
      if (!current) return { ok: false as const, reason: "not_found" as const };

      const data: Record<string, unknown> = {};
      const edits: string[] = [];
      if (input.redirectUris) { data.redirectUris = input.redirectUris.redirectUris; data.allowedOrigins = input.redirectUris.allowedOrigins; edits.push("redirect_uris"); }
      if (input.datasetName !== undefined) { data.datasetName = input.datasetName; edits.push("dataset_name"); }
      const statusChange = input.status && input.status !== current.status ? input.status : null;
      if (statusChange === "disabled") Object.assign(data, { status: "disabled", disabledAt: now, previousSecretHash: null, previousSecretExpiresAt: null });
      if (statusChange === "active") Object.assign(data, { status: "active", disabledAt: null });

      const row: Row = Object.keys(data).length > 0
        ? await tx.oidcClient.update({ where: { id: current.id }, data, select: VIEW_SELECT })
        : await tx.oidcClient.findFirst({ where: { id: current.id }, select: VIEW_SELECT });

      const base = { organizationId: input.site.organizationId, actorId: input.actorId, resourceType: "oidc_client" as const, resourceId: current.id, ipAddress: input.ipAddress, userAgent: input.userAgent };
      if (edits.length > 0) {
        await writeOidcAudit(tx, { ...base, action: "oidc.client.update", details: { clientId: current.clientId, changed: edits.join(",") } });
      }
      if (statusChange) {
        await writeOidcAudit(tx, { ...base, action: statusChange === "disabled" ? "oidc.client.disable" : "oidc.client.enable", details: { clientId: current.clientId } });
      }
      return { ok: true as const, client: toClientView(row, now) };
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function rotateCraftClientSecret(input: Audit & { site: Site }, now: Date = new Date()): Promise<{ ok: true; client: CraftClientView; secret: string } | ClientFailure> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    return await db.$transaction(async (tx: any) => {
      await lockSite(tx, input.site.id);
      const current = await tx.oidcClient.findFirst({
        where: { siteId: input.site.id, organizationId: input.site.organizationId },
        orderBy: { createdAt: "asc" }, select: { id: true, clientId: true, status: true, secretHash: true }
      });
      if (!current) return { ok: false as const, reason: "not_found" as const };
      if (current.status !== "active") return { ok: false as const, reason: "conflict" as const, message: "Enable the client before rotating its secret." };
      const secret = generateClientSecret();
      const row: Row = await tx.oidcClient.update({
        where: { id: current.id },
        data: { secretHash: hashClientSecret(secret), previousSecretHash: current.secretHash, previousSecretExpiresAt: new Date(now.getTime() + ROTATION_OVERLAP_MS), rotatedAt: now },
        select: VIEW_SELECT
      });
      await writeOidcAudit(tx, {
        organizationId: input.site.organizationId, actorId: input.actorId, action: "oidc.client.rotate", resourceType: "oidc_client", resourceId: current.id,
        details: { clientId: current.clientId }, ipAddress: input.ipAddress, userAgent: input.userAgent
      });
      return { ok: true as const, client: toClientView(row, now), secret };
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
