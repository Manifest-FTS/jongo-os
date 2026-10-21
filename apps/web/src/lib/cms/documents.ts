/** Private Node-only CMS repository. No route, import, publish or delivery entry point. */
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getDeliveryDb } from "./delivery-db";
import { isUuid } from "@/lib/site-identity";
import { evaluateCmsEntitlement, type CmsSponsorState } from "./entitlements";
import { sourceIdentity, validateDocument, type NativeEnvelope } from "./schema";
import { parseCmsFields, type Values } from "./form";
import { cmsSchemaRegistry } from "./schemas";
import { inspectJson, isObject, type JsonValue } from "./validation";

export type CmsDocumentErrorCode = "denied" | "conflict" | "invalid" | "unavailable";
export class CmsDocumentError extends Error {
  constructor(public readonly code: CmsDocumentErrorCode) {
    super(`CMS document operation ${code}.`);
    this.name = "CmsDocumentError";
  }
}
function fail(code: CmsDocumentErrorCode): never { throw new CmsDocumentError(code); }
const OPERATION = "cms.draft.save.v1";
const CANONICALIZATION = "jongo-json-sorted-v1";
const MAX_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 512;
const MAX_REFERENCES = 200;
const metadataSelect = {
  id: true, datasetId: true, nativeId: true, type: true, logicalId: true,
  variant: true, slug: true, locale: true, currentRevisionId: true,
  lockVersion: true, createdAt: true, updatedAt: true
} as const;
export type CmsDocumentMetadata = {
  id: string; datasetId: string; nativeId: string; type: string; logicalId: string;
  variant: "draft" | "published"; slug: string | null; locale: string | null;
  currentRevisionId: string | null; lockVersion: number; createdAt: Date; updatedAt: Date;
};
export type CmsDraftReceipt = {
  version: 1; datasetId: string; documentId: string; nativeId: string;
  revisionId: string; nativeRev: string; sequence: number; lockVersion: number;
};
export type SaveCmsDraftInput = {
  /** Trusted authenticated session ID, never a form-supplied principal. */
  userId: string; datasetId: string; documentId?: string; sourceId: string;
  input: unknown; expectedNativeRev?: string | null; expectedLockVersion?: number;
  /** Dataset-scoped retry key, not a client-selected receipt UUID. */
  mutationId: string;
};
type Scope = { userId: string; datasetId: string };
// The generated Prisma client is intentionally not assumed to contain the new
// migration yet. Missing delegates fail unavailable; never legacy/mock fallback.
type Delegate = {
  findFirst(query: unknown): Promise<any>;
  findMany(query: unknown): Promise<any[]>;
  findUnique(query: unknown): Promise<any>;
  create(query: unknown): Promise<any>;
  updateMany(query: unknown): Promise<{ count: number }>;
};
type Tx = {
  user: Delegate; cmsDataset: Delegate; cmsDocument: Delegate;
  cmsRevision: Delegate; cmsMutation: Delegate; cmsReference: Delegate; auditLog: Delegate;
  cmsMarketingRelease: Delegate; cmsMarketingPublication: Delegate;
  cmsDeliveryCredential: Delegate; cmsContentOutbox: Delegate;
  cmsApprovedMedia: Delegate;
  cmsMediaCleanupJob: Delegate;
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};
function uuid(value: unknown): value is string { return typeof value === "string" && isUuid(value); }
function text(value: unknown, max = MAX_TEXT_BYTES): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function assertScope(scope: Scope, write = false): void {
  if (typeof window !== "undefined" || process.env.JONGO_CMS_ENABLED !== "true" ||
  (write && process.env.JONGO_CMS_WRITES_ENABLED !== "true") ||
      !uuid(scope.userId) || !uuid(scope.datasetId)) fail("denied");
}
/** UTF-16 code-unit key sorting, JSON number/string encoding, no Unicode normalization.
 * Called only on inspected, detached JSON. This is versioned, not RFC 8785. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function boundedJson(value: unknown): JsonValue {
  if (inspectJson(value).length) fail("invalid");
  // Structural budgets have already passed. Inspect decoded code units, not
  // serialized escapes: literal backslash-u text is valid PostgreSQL JSONB.
  function string(value: string): void {
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) fail("invalid");
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("invalid");
      }
    }
  }
  function walk(node: JsonValue): void {
    if (typeof node === "string") string(node);
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) { string(key); walk(child); }
    }
  }
  walk(value as JsonValue);
  const encoded = canonical(value as JsonValue);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) fail("invalid");
  return JSON.parse(encoded) as JsonValue;
}

/** Same persisted policy as dataset-access, evaluated here because its public
 * resolver owns a separate transaction. Never call that resolver as write proof.
 * Keep this bridge aligned until that module exports a tx-bound policy helper. */
async function authorize(tx: Tx, scope: Scope, edit: boolean, minimumRank = 1): Promise<{ organizationId: string; ownerId: string; siteId: string | null }> {
  assertScope(scope, edit);
  const { userId, datasetId } = scope;
  const actor = await tx.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } });
  if (!actor || actor.id !== userId || actor.deletedAt !== null) fail("denied");
  const dataset = await tx.cmsDataset.findUnique({ where: { id: datasetId }, select: {
    id: true, organizationId: true, siteId: true, archivedAt: true,
    organization: { select: { id: true, ownerId: true, deletedAt: true,
      owner: { select: { id: true, deletedAt: true, subscriptionPlanId: true,
        subscriptionStatus: true, subscriptionCurrentPeriodEnd: true } },
      collaborators: { where: { userId, deletedAt: null },
        select: { organizationId: true, userId: true, role: true, deletedAt: true } }
    } },
    site: { select: { id: true, organizationId: true, deletedAt: true,
      collaborators: { where: { userId, deletedAt: null },
        select: { siteId: true, userId: true, role: true, deletedAt: true } } } },
    grants: { where: { userId, revokedAt: null },
      select: { datasetId: true, userId: true, role: true, revokedAt: true } }
  } });
  const org = dataset?.organization;
  if (!dataset || dataset.id !== datasetId || dataset.archivedAt !== null || !uuid(dataset.organizationId) ||
      !org || org.id !== dataset.organizationId || org.deletedAt !== null || !uuid(org.ownerId) ||
      !org.owner || org.owner.id !== org.ownerId || org.owner.deletedAt !== null) fail("denied");
  const site = dataset.site;
  if (dataset.siteId !== null && (!uuid(dataset.siteId) || !site || site.id !== dataset.siteId ||
      site.organizationId !== org.id || site.deletedAt !== null)) fail("denied");
  const live = (m: any) => m.userId === userId && m.deletedAt === null &&
    (m.role === "admin" || m.role === "collaborator");
  const owner = org.ownerId === userId;
  const member = org.collaborators.find((m: any) => m.organizationId === org.id && live(m));
  const siteMember = dataset.siteId !== null && site?.collaborators.some((m: any) => m.siteId === dataset.siteId && live(m));
  const grant = dataset.grants.find((g: any) => g.datasetId === datasetId && g.userId === userId && g.revokedAt === null);
  const roles = ["reader", "editor", "publisher", "admin"];
  if ((!owner && !member && !siteMember) || (!owner && !member && !grant) ||
      (grant && !roles.includes(grant.role))) fail("denied");
  const rank = Math.max(owner || member?.role === "admin" ? 3 : 0, grant ? roles.indexOf(grant.role) : 0);
  const permits = (feature: "cms.read" | "cms.author") => evaluateCmsEntitlement({
    feature, organizationId: org.id, sponsor: org.owner as CmsSponsorState,
    scope: { organizationId: org.id, ownerId: org.ownerId, userId: org.ownerId, role: "owner" },
    enabled: process.env.JONGO_CMS_ENABLED === "true", now: new Date()
  });
  if (!permits("cms.read") || (edit && (rank < minimumRank || !permits("cms.author")))) fail("denied");
  return { organizationId: org.id, ownerId: org.ownerId, siteId: dataset.siteId };
}

/** Fixed SQL identifiers and parameterized values only. Order: dataset UPDATE,
 * organization SHARE, sorted actor/sponsor SHARE, org membership, dataset grant,
 * optional site and site membership SHARE. No policy table locks. Existing rows
 * (including revoked/deleted memberships) block UPDATE/DELETE until commit.
 * Absent rows cannot be row-locked: SERIALIZABLE policy predicate rereads cover
 * inserts; a new grant can only broaden access, not revoke existing authority.
 * External writers with a different order may deadlock; retry the whole tx.
 */
async function lockPolicy(tx: Tx, scope: Scope): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "CmsDataset" WHERE id = ${scope.datasetId}::uuid FOR UPDATE`;
  const policy = await authorize(tx, scope, true);
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${policy.organizationId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${scope.userId}::uuid, ${policy.ownerId}::uuid) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Collaborator" WHERE "organizationId" = ${policy.organizationId}::uuid AND "userId" = ${scope.userId}::uuid ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "CmsDatasetGrant" WHERE "datasetId" = ${scope.datasetId}::uuid AND "userId" = ${scope.userId}::uuid ORDER BY id FOR SHARE`;
  if (policy.siteId !== null) {
    await tx.$queryRaw`SELECT id FROM "Site" WHERE id = ${policy.siteId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "SiteCollaborator" WHERE "siteId" = ${policy.siteId}::uuid AND "userId" = ${scope.userId}::uuid ORDER BY id FOR SHARE`;
  }
}

async function transaction<T>(scope: Scope, write: boolean, action: (tx: Tx, organizationId: string) => Promise<T>, silent = false): Promise<T> {
  assertScope(scope, write);
  try {
    const db = silent ? getDeliveryDb() : await getDb();
    if (!db) return fail("unavailable");
    // Retrying always starts a NEW transaction and reauthorizes, including replay.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Denied callers never acquire row locks. This fresh preliminary guard
        // is not write authority: the transaction locks and rereads policy.
        if (write) await authorize(db as unknown as Tx, scope, true);
        return await db.$transaction(async (tx: Tx) => {
          if (write) {
            assertScope(scope, true);
            await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
            await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
            await lockPolicy(tx, scope);
          }
          const policy = await authorize(tx, scope, write);
          return action(tx, policy.organizationId);
        }, { isolationLevel: write ? "Serializable" : "RepeatableRead", maxWait: 3000, timeout: 10000 });
      } catch (error) {
        const code = isObject(error) ? error.code : undefined;
        // Raw SELECT locks may surface PostgreSQL serialization/deadlock states
        // through P2010 rather than Prisma's transaction-level P2034 wrapper.
        const sqlState = isObject(error) && isObject(error.meta) ? error.meta.code : undefined;
        const retryable = code === "P2034" || code === "P2002" ||
          (code === "P2010" && (sqlState === "40001" || sqlState === "40P01"));
        if (write && retryable && attempt < 2) continue;
        if (retryable) return fail("conflict");
        throw error;
      }
    }
    return fail("unavailable");
  } catch (error) {
    // No payload, SQL detail, DB error cause or private diagnostic is logged.
    if (error instanceof CmsDocumentError) throw error;
    return fail("unavailable");
  }
}

/** Internal server repository bridge. The caller cannot disable write policy or
 * locks. Never accept a callback from HTTP/client input. */
export function withCmsWriteTransaction<T>(scope: Scope, action: (tx: Tx, organizationId: string) => Promise<T>): Promise<T> {
  return transaction(scope, true, action);
}

/** Internal publication/credential boundary: same locks and both flags, then
 * fresh transaction-bound publisher/admin policy, never cached UI capability. */
export function executeCmsWriteTransaction<T>(scope: Scope, permission: "publish" | "manage",
  action: (tx: Tx, policy: { organizationId: string; ownerId: string; siteId: string | null }) => Promise<T>): Promise<T> {
  return transaction(scope, true, async (tx) => {
    const policy = await authorize(tx, scope, true, permission === "publish" ? 2 : 3);
    return action(tx, policy);
  }, true);
}

/** Bounded private metadata only; no revision relation, payload or consent evidence. */
export async function listCmsDocuments(input: Scope & { limit?: number; afterId?: string; type?: string; variant?: "draft" | "published" }): Promise<CmsDocumentMetadata[]> {
  const scope = { ...input };
  assertScope(scope);
  const limit = scope.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (scope.afterId !== undefined && !uuid(scope.afterId)) ||
      (scope.type !== undefined && !cmsSchemaRegistry.get(scope.type)) ||
      (scope.variant !== undefined && scope.variant !== "draft" && scope.variant !== "published")) fail("invalid");
  return transaction(scope, false, (tx) => tx.cmsDocument.findMany({
    where: { datasetId: scope.datasetId, archivedAt: null,
      ...(scope.variant ? { variant: scope.variant } : {}),
      ...(scope.afterId ? { id: { gt: scope.afterId } } : {}), ...(scope.type ? { type: scope.type } : {}) },
    select: metadataSelect, orderBy: { id: "asc" }, take: limit
  }));
}

/** Authenticated private editor read; never a public DTO or historical/raw record. */
export async function getCmsDocument(input: Scope & { documentId: string }): Promise<{
  document: CmsDocumentMetadata; draft: { id: string; nativeRev: string; sequence: number; schemaVersion: number; payload: JsonValue } | null;
} | null> {
  const scope = { ...input };
  assertScope(scope);
  if (!uuid(scope.documentId)) fail("invalid");
  return transaction(scope, false, async (tx) => {
    const document = await tx.cmsDocument.findFirst({ where: {
      id: scope.documentId, datasetId: scope.datasetId, variant: "draft", archivedAt: null
    }, select: metadataSelect });
    if (!document) return null;
    const draft = document.currentRevisionId ? await tx.cmsRevision.findFirst({ where: {
      id: document.currentRevisionId, datasetId: scope.datasetId, documentId: document.id
    }, select: { id: true, nativeRev: true, sequence: true, schemaVersion: true, payload: true } }) : null;
    if (document.currentRevisionId && !draft) fail("unavailable");
    return { document, draft };
  });
}

type Edge = { path: string; sourceRef: string; weak: boolean };
function references(value: JsonValue): Edge[] {
  const edges: Edge[] = [];
  function walk(node: JsonValue, path: string): void {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && node._type === "reference") {
      if (!text(node._ref) || Buffer.byteLength(path, "utf8") > 1024) fail("invalid");
      edges.push({ path, sourceRef: node._ref, weak: node._weak === true });
      if (edges.length > MAX_REFERENCES) fail("invalid");
    }
    Object.entries(node).forEach(([key, child]) => walk(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  walk(value, "");
  return edges;
}
function receipt(value: unknown, datasetId: string, nativeId: string): CmsDraftReceipt {
  if (!isObject(value) || value.version !== 1 || value.datasetId !== datasetId || value.nativeId !== nativeId ||
      !uuid(value.documentId) || !uuid(value.revisionId) || !text(value.nativeRev) ||
      !Number.isInteger(value.sequence) || Number(value.sequence) < 1 ||
      !Number.isInteger(value.lockVersion) || Number(value.lockVersion) < 1) return fail("unavailable");
  // Explicit projection even for stored receipts: no future private field leak.
  return { version: 1, datasetId, documentId: value.documentId, nativeId, revisionId: value.revisionId,
    nativeRev: value.nativeRev, sequence: Number(value.sequence), lockVersion: Number(value.lockVersion) };
}

export function saveCmsDraft(input: SaveCmsDraftInput): Promise<CmsDraftReceipt> {
  return persistCmsDraft(input);
}

/** Server-action transport entry. Raw identity is independent of current descriptors
 * and parser behavior. No caller-supplied hash or authorization shortcut. */
export function saveCmsDraftForm(input: Omit<SaveCmsDraftInput, "input"> & {
  envelope: NativeEnvelope; serializedForm: string;
}): Promise<CmsDraftReceipt> {
  return persistCmsDraft({ ...input, input: null }, {
    envelope: input.envelope, serializedForm: input.serializedForm
  });
}

async function persistCmsDraft(input: SaveCmsDraftInput, form?: { envelope: NativeEnvelope; serializedForm: string }): Promise<CmsDraftReceipt> {
  // Detach request scalars before the first await; callers cannot change a retry
  // key, actor, scope or expectation after its canonical request hash is made.
  const args = { ...input };
  assertScope(args);
  if (!text(args.sourceId) || !text(args.mutationId, 128) ||
      (args.documentId !== undefined && !uuid(args.documentId)) ||
      (args.expectedNativeRev !== undefined && args.expectedNativeRev !== null && !text(args.expectedNativeRev)) ||
      (args.expectedLockVersion !== undefined && (!Number.isInteger(args.expectedLockVersion) || args.expectedLockVersion < 0 || args.expectedLockVersion >= 2147483647))) fail("invalid");
  const identity = sourceIdentity(args.sourceId);
  // This is not an importer or promotion API. Never rewrite a published identity.
  if (identity.variant !== "draft" || !text(identity.logicalId)) fail("invalid");
  const submitted = boundedJson(form ?? args.input);
  if (form && (!isObject(submitted) || typeof submitted.serializedForm !== "string" ||
      Buffer.byteLength(submitted.serializedForm, "utf8") > MAX_BYTES || !isObject(submitted.envelope) ||
      submitted.envelope._id !== args.sourceId)) fail("invalid");
  const payloadSha256 = sha(canonical(submitted));
  const operation = form ? "cms.draft.form.save.v1" : OPERATION;
  // Fingerprint the exact detached request, including submitted envelope fields.
  // Registry versions are mutable server state, not part of request identity.
  const requestSha256 = sha(canonical({ canonicalization: CANONICALIZATION, operation,
    actorId: args.userId, datasetId: args.datasetId, sourceId: args.sourceId,
    documentId: args.documentId ?? null, expectedNativeRev: args.expectedNativeRev ?? null,
    expectedLockVersion: args.expectedLockVersion ?? null, payloadSha256 }));
  return transaction(args, true, async (tx, organizationId) => {
    const previous = await tx.cmsMutation.findUnique({ where: { datasetId_key: { datasetId: args.datasetId, key: args.mutationId } },
      select: { actorId: true, operation: true, requestSha256: true, result: true } });
    if (previous) {
      if (previous.actorId !== args.userId || previous.operation !== operation || previous.requestSha256 !== requestSha256) fail("conflict");
      return receipt(previous.result, args.datasetId, args.sourceId);
    }
    // Only NEW mutations use the current schema. A freshly authorized exact
    // replay survives a registry upgrade/removal without rewriting its source.
    let payload = submitted;
    if (form) {
      const transport = submitted as { envelope: NativeEnvelope; serializedForm: string };
      const schema = cmsSchemaRegistry.get(transport.envelope._type);
      if (!schema) fail("invalid");
      let values: unknown;
      try { values = JSON.parse(transport.serializedForm); } catch { return fail("invalid"); }
      if (!isObject(values) || inspectJson(values).length || Object.entries(values).some(([key, value]) => {
        const field = schema.fields.find((candidate) => candidate.name === key);
        return !field || (field.type === "boolean" ? value !== "" && typeof value !== "boolean" : typeof value !== "string");
      })) fail("invalid");
      const { fields, errors } = parseCmsFields(schema, values as Values);
      if (errors.length) fail("invalid");
      payload = boundedJson({ ...fields, ...transport.envelope });
    }
    const savedPayloadSha256 = sha(canonical(payload));
    const checked = validateDocument(payload, cmsSchemaRegistry, { mode: "draft" });
    if (!checked.valid || !checked.value || checked.findings.some((f) => f.disposition === "quarantine") ||
        checked.value._id !== args.sourceId || !text(checked.value._type)) fail("invalid");
    const definition = cmsSchemaRegistry.get(checked.value._type);
    if (!definition) fail("invalid");
    const body = payload as Record<string, JsonValue>;
    const slug = isObject(body.slug) ? body.slug.current : null;
    const locale = body.locale ?? null;
    if ((slug !== null && !text(slug)) || (locale !== null && !text(locale))) fail("invalid");
    const edges = references(payload);
    const targets = edges.length ? await tx.cmsDocument.findMany({ where: { datasetId: args.datasetId,
      nativeId: { in: edges.map((edge) => edge.sourceRef) }, archivedAt: null },
      select: { id: true, nativeId: true, type: true }, take: MAX_REFERENCES }) : [];
    const targetMap = new Map<string, { id: string; _type: string }>(targets.map((target) =>
      [target.nativeId, { id: target.id, _type: target.type }]));
    const scopedValidation = validateDocument(payload, cmsSchemaRegistry, { mode: "draft", records: targetMap });
    if (!scopedValidation.valid || !scopedValidation.value || scopedValidation.findings.some((f) => f.disposition === "quarantine")) fail("invalid");
    let document = await tx.cmsDocument.findFirst({ where: { datasetId: args.datasetId,
      ...(args.documentId ? { id: args.documentId } : { nativeId: args.sourceId }) }, select: { ...metadataSelect, archivedAt: true } });
    if (document && (document.archivedAt !== null || document.variant !== "draft" || document.nativeId !== args.sourceId ||
        document.type !== body._type || document.logicalId !== identity.logicalId)) fail("conflict");
    if (!document && args.documentId) fail("conflict");
    if (document) {
      // Dataset lock serializes this service's creates; this document lock also
      // coordinates other row writers. CAS below still checks pointer + version.
      await tx.$queryRaw`SELECT id FROM "CmsDocument" WHERE "datasetId" = ${args.datasetId}::uuid AND id = ${document.id}::uuid FOR UPDATE`;
    }
    let current: any = null;
    if (document?.currentRevisionId) {
      current = await tx.cmsRevision.findFirst({ where: { datasetId: args.datasetId, documentId: document.id,
        id: document.currentRevisionId }, select: { id: true, nativeRev: true, sequence: true,
          sourceRev: true, sourceCreatedAt: true, sourceUpdatedAt: true,
          sourceRecordRaw: true, sourceSha256: true, provenance: true } });
      if (!current) fail("unavailable");
    }
    if (document) {
      // Payload _rev is source metadata only and is NEVER compared here.
      if (!current || args.expectedNativeRev !== current.nativeRev ||
          (args.expectedLockVersion !== undefined && args.expectedLockVersion !== document.lockVersion)) fail("conflict");
    } else {
      if (args.expectedNativeRev != null || (args.expectedLockVersion !== undefined && args.expectedLockVersion !== 0)) fail("conflict");
      const now = new Date();
      document = await tx.cmsDocument.create({ data: { id: randomUUID(), datasetId: args.datasetId,
        nativeId: args.sourceId, logicalId: identity.logicalId, variant: "draft", type: body._type,
        currentRevisionId: null, lockVersion: 0, createdAt: now, updatedAt: now }, select: metadataSelect });
    }
    // Allocate from retained history, not source tokens or a potentially older pointer.
    const last = await tx.cmsRevision.findFirst({ where: { datasetId: args.datasetId, documentId: document.id },
      orderBy: { sequence: "desc" }, select: { sequence: true } });
    const sequence = (last?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence > 2147483647 || document.lockVersion >= 2147483647) fail("conflict");
    const mutationId = randomUUID();
    const revisionId = randomUUID();
    const nativeRev = randomUUID();
    const now = new Date();
    const result: CmsDraftReceipt = { version: 1, datasetId: args.datasetId, documentId: document.id,
      nativeId: args.sourceId, revisionId, nativeRev, sequence, lockVersion: document.lockVersion + 1 };
    await tx.cmsMutation.create({ data: { id: mutationId, datasetId: args.datasetId, actorId: args.userId,
      key: args.mutationId, operation, requestSha256, result, createdAt: now } });
    await tx.cmsRevision.create({ data: { id: revisionId, datasetId: args.datasetId, documentId: document.id,
      sequence, schemaVersion: definition.schemaVersion, nativeRev, payload, payloadSha256: savedPayloadSha256,
      // Native edits cannot mint/replace import provenance from caller envelope
      // metadata. Raw imported bytes/hash remain exact, not regenerated payload.
      sourceRev: current?.sourceRev ?? null, sourceCreatedAt: current?.sourceCreatedAt ?? null,
      sourceUpdatedAt: current?.sourceUpdatedAt ?? null, sourceRecordRaw: current?.sourceRecordRaw ?? null,
      sourceSha256: current?.sourceSha256 ?? null,
      provenance: { ...(isObject(current?.provenance) ? current.provenance : {}),
        ...(!current ? { origin: "native", submittedEnvelope: {
          _rev: body._rev, _createdAt: body._createdAt, _updatedAt: body._updatedAt
        }, submittedEnvelopeTrusted: false } : {}),
        canonicalization: CANONICALIZATION, operation },
      actorId: args.userId, mutationId, createdAt: now, ingestedAt: now } });
    for (const edge of edges) {
      const target = targetMap.get(edge.sourceRef);
      await tx.cmsReference.create({ data: { id: randomUUID(), datasetId: args.datasetId,
        sourceRevisionId: revisionId, ...edge, state: target ? "resolved" : "unresolved",
        targetDocumentId: target?.id ?? null, diagnosticCode: target ? null : "target_unverified" } });
    }
    const updated = await tx.cmsDocument.updateMany({ where: { datasetId: args.datasetId, id: document.id,
      variant: "draft", archivedAt: null, currentRevisionId: document.currentRevisionId, lockVersion: document.lockVersion },
      data: { currentRevisionId: revisionId, lockVersion: { increment: 1 }, slug, locale, updatedAt: now } });
    if (updated.count !== 1) fail("conflict");
    await tx.auditLog.create({ data: { organizationId, actorId: args.userId, action: operation,
      resourceType: "cms_document", resourceId: document.id, details: {
        datasetId: args.datasetId, documentId: document.id, revisionId, sequence,
        lockVersion: result.lockVersion, requestSha256, payloadSha256: savedPayloadSha256, mutationId
      } } });
    return result;
  });
}