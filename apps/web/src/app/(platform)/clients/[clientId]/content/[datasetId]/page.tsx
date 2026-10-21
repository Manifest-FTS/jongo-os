import React from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/site-identity";
import { resolveDatasetCmsCapabilities } from "@/lib/cms/dataset-access";
import { getCmsDocument, listCmsDocuments } from "@/lib/cms/documents";
import { cmsSchemaRegistry } from "@/lib/cms/schemas";
import { isObject } from "@/lib/cms/validation";
import DraftEditor from "@/components/cms/DraftEditor";
import MarketingAdminControls from "@/components/cms/MarketingAdminControls";
import { createDraftSaveAction, createMarketingAdminActions } from "./actions";

export const dynamic = "force-dynamic";

export default async function DatasetContentPage({ params, searchParams }: {
  params: Promise<{ clientId: string; datasetId: string }>;
  searchParams: Promise<{ docId?: string | string[]; type?: string | string[]; afterId?: string | string[] }>;
}) {
  const { clientId, datasetId } = await params;
  const query = await searchParams;
  if (!isUuid(clientId) || !isUuid(datasetId) ||
      (query.docId !== undefined && (typeof query.docId !== "string" || !isUuid(query.docId))) ||
      (query.type !== undefined && (typeof query.type !== "string" || !cmsSchemaRegistry.get(query.type))) ||
      (query.afterId !== undefined && (typeof query.afterId !== "string" || !isUuid(query.afterId))) ||
      (query.afterId !== undefined && (query.docId !== undefined || query.type !== undefined))) notFound();
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || !isUuid(userId)) notFound();
  if (process.env.JONGO_CMS_ENABLED !== "true") return <section className="card"><h2>CMS unavailable</h2><p>The CMS feature is disabled.</p></section>;
  const caps = await resolveDatasetCmsCapabilities(userId, datasetId);
  if (caps.scope !== "dataset" || caps.datasetId !== datasetId || caps.organizationId !== clientId || !caps.canRead) notFound();
  const url = `/clients/${clientId}/content/${datasetId}`;
  const canEdit = caps.canEdit && process.env.JONGO_CMS_WRITES_ENABLED === "true";
  const canPublish = caps.canPublish && process.env.JONGO_CMS_WRITES_ENABLED === "true";
  const canManage = caps.canManageDataset && process.env.JONGO_CMS_WRITES_ENABLED === "true";
  const adminActions = createMarketingAdminActions({ clientId, datasetId });
  let publication: { status: "active" | "revoked"; revision: number; hasRelease: boolean } = { status: "revoked", revision: 0, hasRelease: false };
  let credentials: Array<{ id: string; prefix: string; createdAt: string; expiresAt: string | null; revokedAt: string | null }> = [];
  let revisionOptions: Array<{ id: string; type: "agencyWork" | "partnerStories" | "article"; label: string }> = [];
  let adminReadError = false;
  try {
    const marketingTypes = ["agencyWork", "partnerStories", "article"] as const;
    const db = await getDb();
    if (!db) throw new Error("unavailable");
    const adminData = await db.$transaction(async (tx: any) => {
      const pointer = await tx.cmsMarketingPublication.findUnique({ where: { datasetId }, select: { revision: true, status: true, releaseId: true } });
      const rows = await tx.cmsDeliveryCredential.findMany({ where: { datasetId, type: "marketing.read" },
        select: { id: true, prefix: true, createdAt: true, expiresAt: true, revokedAt: true },
        orderBy: { createdAt: "desc" }, take: 100 });
      const drafts = await tx.cmsDocument.findMany({ where: { datasetId, archivedAt: null, variant: "draft", type: { in: [...marketingTypes] } },
        select: { datasetId: true, id: true, nativeId: true, type: true, slug: true, currentRevisionId: true,
          currentRevision: { select: { id: true, datasetId: true, documentId: true } } }, orderBy: { id: "asc" }, take: 100 });
      return { pointer, rows, drafts };
    }, { isolationLevel: "RepeatableRead" });
    revisionOptions = adminData.drafts.flatMap((doc: any) => doc.currentRevisionId && doc.currentRevision?.id === doc.currentRevisionId &&
      doc.currentRevision.datasetId === datasetId && doc.currentRevision.documentId === doc.id && doc.datasetId === datasetId && marketingTypes.includes(doc.type)
      ? [{ id: doc.currentRevisionId, type: doc.type, label: doc.slug ?? doc.nativeId }] : []);
    if (adminData.pointer) publication = { status: adminData.pointer.status === "active" ? "active" : "revoked",
      revision: Number.isInteger(adminData.pointer.revision) ? adminData.pointer.revision : 0,
      hasRelease: typeof adminData.pointer.releaseId === "string" };
    credentials = adminData.rows.map((row: any) => ({ id: row.id, prefix: row.prefix,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : "",
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : null,
      revokedAt: row.revokedAt instanceof Date ? row.revokedAt.toISOString() : null }));
  } catch {
    adminReadError = true;
    revisionOptions = [];
    credentials = [];
  }
  const adminControls = <MarketingAdminControls key={`${datasetId}:${revisionOptions.map(option => option.id).join(",")}`} publication={publication} revisions={revisionOptions} credentials={credentials}
    canPublish={canPublish && !adminReadError} canManage={canManage && !adminReadError} actions={adminActions} loadError={adminReadError} />;
  try {
    if (query.docId || query.type) {
      const stored = query.docId ? await getCmsDocument({ userId, datasetId, documentId: query.docId }) : null;
      if (query.docId && (!stored?.draft || stored.document.datasetId !== datasetId)) notFound();
      const schema = cmsSchemaRegistry.get(stored?.document.type ?? query.type!);
      if (!schema || (query.type && stored && query.type !== stored.document.type)) notFound();
      const now = new Date().toISOString();
      const initialDocument = stored?.draft?.payload ?? {
        _id: `drafts.${randomUUID()}`, _type: schema.name, _rev: `native.initial.${randomUUID()}`,
        _createdAt: now, _updatedAt: now
      };
      if (!isObject(initialDocument)) notFound();
      const envelope = {
        _id: stored?.document.nativeId ?? String(initialDocument._id), _type: schema.name,
        _rev: String(initialDocument._rev), _createdAt: String(initialDocument._createdAt), _updatedAt: String(initialDocument._updatedAt)
      };
      return <section className="page-stack">{adminControls}<h2>Private draft</h2><Link href={url}>Back to documents</Link>
        {!canEdit && <p>Read-only. Draft writes are disabled or authoring access is unavailable.</p>}
        <DraftEditor key={`${stored?.document.id ?? envelope._id}:${stored?.draft?.nativeRev ?? "new"}`}
          schema={schema} initialDocument={initialDocument} canEdit={canEdit}
          documentId={stored?.document.id ?? null} nativeRev={stored?.draft?.nativeRev ?? null}
          documentUrl={url} saveAction={createDraftSaveAction({ clientId, datasetId, envelope })} />
      </section>;
    }
    const documents = await listCmsDocuments({ userId, datasetId, limit: 100, variant: "draft",
      ...(query.afterId ? { afterId: query.afterId } : {}) });
    // A bounded lookahead avoids a false Next link for an exactly-full last page.
    const lastId = documents.at(-1)?.id;
    const hasNext = documents.length === 100 && lastId && (await listCmsDocuments({
      userId, datasetId, limit: 1, variant: "draft", afterId: lastId
    })).length > 0;
    return <section className="page-stack">{adminControls}<h2>Dataset content</h2><p>Private drafts only. Saving never publishes.</p>
      <ul>{documents.map((doc) => <li key={doc.id}><Link href={`${url}?docId=${doc.id}`}>{doc.type}: {doc.nativeId}</Link></li>)}</ul>
      {!documents.length && <p>No documents in this dataset.</p>}
      <nav aria-label="Draft pagination">
        {query.afterId && <Link href={url}>First page</Link>}
        {hasNext && <Link href={`${url}?afterId=${encodeURIComponent(lastId!)}`}>Next drafts</Link>}
      </nav>
      {canEdit && <nav aria-label="Create draft">{cmsSchemaRegistry.descriptors.map((schema) => <p key={schema.name}><Link href={`${url}?type=${schema.name}`}>New {schema.title} draft</Link></p>)}</nav>}
    </section>;
  } catch (error) {
    // Preserve Next's notFound control flow, without rendering private failures.
    if (isObject(error) && typeof error.digest === "string" && error.digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) throw error;
    return <section className="card"><h2>CMS unavailable</h2><p>Content could not be loaded. No content was changed.</p></section>;
  }
}