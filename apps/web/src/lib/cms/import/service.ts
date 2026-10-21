import { randomUUID } from "node:crypto";
import { CmsDocumentError, withCmsWriteTransaction } from "../documents";
import { cmsSchemaRegistry } from "../schemas";
import { sourceIdentity } from "../schema";
import { canonical, MAPPING, planImport, type ImportReport } from "./planner";
import { assertReviewedSnapshot, ImportError, sha256 } from "./reader";
import { assertLocalDatabase } from "./local-database";
export { assertLocalDatabase } from "./local-database";
export type ImportOptions = { file: string; datasetId: string; actorId: string; apply?: boolean; confirmDataset?: string; expectedSha256?: string };
export type ApplyReport = ImportReport & { mode: "dry-run" | "apply"; applied: number; replayed: boolean; jobId: string | null };

/** Trusted local operator entry point, NOT an HTTP authentication mechanism.
 * The explicit actor is checked against live tenant policy by the SAME guarded
 * transaction used by native editing. No grants/entitlements are synthesized. */
export async function importSanity(options: ImportOptions): Promise<ApplyReport> {
  const args = { ...options };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.datasetId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.actorId)) throw new ImportError("scope");
  if (args.apply) assertReviewedSnapshot(args.expectedSha256);
  const databaseName = args.apply ? assertLocalDatabase() : null;
  if (args.apply && args.confirmDataset !== args.datasetId) throw new ImportError("confirmation_required");
  const plan = await planImport(args.file);
  const report: ApplyReport = { ...plan.report, mode: args.apply ? "apply" : "dry-run", applied: 0, replayed: false, jobId: null };
  if (!args.apply) return report;
  // Compare this exact retained plan, not a separate read, before any DB access.
  assertReviewedSnapshot(args.expectedSha256, plan.snapshot.sha256);
  if (plan.candidates.length > 100) throw new ImportError("atomic_batch_limit");
  // This is an atomic bounded import, not a partial job/checkpoint mechanism.
  // Refuse to pretend a quarantine-only apply staged or restored anything.
  if (!plan.candidates.length) throw new ImportError("no_eligible_drafts");
  const schemaHash = sha256(canonical(cmsSchemaRegistry.descriptors as unknown as import("../validation").JsonValue));
  // snapshot is now the supplied reviewed hash; retain the existing fingerprint
  // and receipt identity, including exact source bytes, for compatible replay.
  const requestSha256 = sha256(canonical({ mapping: MAPPING, actorId: args.actorId, datasetId: args.datasetId,
    snapshot: plan.snapshot.sha256, schemaHash, entries: plan.candidates.map(c => [c.value._id, c.sha256, c.payloadSha256]) }));
  const jobId = `sanity-v1:${sha256(`${args.datasetId}:${plan.snapshot.sha256}`)}`;
  const operation = "cms.import.registered-drafts.v1";
  try {
    return await withCmsWriteTransaction({ userId: args.actorId, datasetId: args.datasetId }, async (tx, organizationId) => {
      const identity = await tx.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address` as Array<{ name: string; address: string }>;
      if (identity[0]?.name !== databaseName || !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(identity[0]?.address)) throw new CmsDocumentError("denied");
      const previous = await tx.cmsMutation.findUnique({ where: { datasetId_key: { datasetId: args.datasetId, key: jobId } },
        select: { actorId: true, operation: true, requestSha256: true, result: true } });
      if (previous) {
        if (previous.actorId !== args.actorId || previous.operation !== operation || previous.requestSha256 !== requestSha256 ||
            previous.result?.version !== 1 || previous.result?.count !== plan.candidates.length) throw new CmsDocumentError("conflict");
        return { ...report, replayed: true, jobId };
      }
      const targets = new Map<string, string>();
      // Pass 1 allocates ALL exact identities; never upsert/overwrite existing
      // drafts, published variants or a document edited after an earlier import.
      for (const candidate of plan.candidates) {
        const nativeId = candidate.value._id as string;
        const existing = await tx.cmsDocument.findFirst({ where: { datasetId: args.datasetId, nativeId }, select: { id: true } });
        if (existing) throw new CmsDocumentError("conflict");
        const id = randomUUID(), now = new Date();
        await tx.cmsDocument.create({ data: { id, datasetId: args.datasetId, nativeId,
          type: candidate.value._type, logicalId: sourceIdentity(nativeId).logicalId, variant: "draft",
          currentRevisionId: null, lockVersion: 0, createdAt: now, updatedAt: now } });
        targets.set(nativeId, id);
      }
      const mutationId = randomUUID();
      await tx.cmsMutation.create({ data: { id: mutationId, datasetId: args.datasetId, actorId: args.actorId,
        key: jobId, operation, requestSha256, result: { version: 1, count: plan.candidates.length }, createdAt: new Date() } });
      // Pass 2 preserves raw records/ASTs unchanged and resolves exact IDs. Weak
      // missing targets remain explicit private findings; strong closure passed.
      for (const candidate of plan.candidates) {
        const body = candidate.value, documentId = targets.get(body._id as string)!;
        const revisionId = randomUUID(), nativeRev = randomUUID(), now = new Date();
        await tx.cmsRevision.create({ data: { id: revisionId, datasetId: args.datasetId, documentId,
          sequence: 1, schemaVersion: candidate.schemaVersion, nativeRev, sourceRev: body._rev,
          sourceCreatedAt: body._createdAt, sourceUpdatedAt: body._updatedAt, payload: body,
          payloadSha256: candidate.payloadSha256, sourceRecordRaw: candidate.raw, sourceSha256: candidate.sha256,
          provenance: { origin: "sanity-ndjson", mapping: MAPPING, snapshotSha256: plan.snapshot.sha256,
            schemaHash, canonicalization: "jongo-json-sorted-v1", operation, jobId, line: candidate.line },
          actorId: args.actorId, mutationId, createdAt: now, ingestedAt: now } });
        for (const edge of candidate.edges) {
          const targetDocumentId = targets.get(edge.sourceRef) ?? null;
          await tx.cmsReference.create({ data: { id: randomUUID(), datasetId: args.datasetId, sourceRevisionId: revisionId,
            ...edge, state: targetDocumentId ? "resolved" : "unresolved", targetDocumentId,
            diagnosticCode: targetDocumentId ? null : "weak_target_unavailable" } });
        }
        const slug = body.slug && typeof body.slug === "object" && !Array.isArray(body.slug) ? body.slug.current : null;
        const update = await tx.cmsDocument.updateMany({ where: { datasetId: args.datasetId, id: documentId,
          variant: "draft", archivedAt: null, currentRevisionId: null, lockVersion: 0 },
          data: { currentRevisionId: revisionId, lockVersion: { increment: 1 }, slug, locale: body.locale ?? null, updatedAt: now } });
        if (update.count !== 1) throw new CmsDocumentError("conflict");
      }
      await tx.auditLog.create({ data: { organizationId, actorId: args.actorId, action: operation,
        resourceType: "cms_dataset", resourceId: args.datasetId,
        details: { datasetId: args.datasetId, jobId, requestSha256, count: plan.candidates.length } } });
      return { ...report, applied: plan.candidates.length, jobId };
    });
  } catch (error) {
    throw new ImportError(error instanceof CmsDocumentError ? error.code : "unavailable");
  }
}