-- Additive foundation only: no content import, backfill, grants or publication.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "CmsDatasetRole" AS ENUM ('reader', 'editor', 'publisher', 'admin');
CREATE TYPE "CmsDocumentVariant" AS ENUM ('draft', 'published');
CREATE TYPE "CmsReferenceState" AS ENUM ('resolved', 'unresolved', 'excluded', 'invalid');

-- The only change to an existing table: additive ownership-pair uniqueness.
CREATE UNIQUE INDEX "Site_id_organizationId_key" ON "Site"("id", "organizationId");

CREATE TABLE "CmsDataset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "siteId" UUID,
    "key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "CmsDataset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsDataset_names_check" CHECK (length("key") > 0 AND length("environment") > 0 AND length("name") > 0)
);

CREATE TABLE "CmsDatasetGrant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "CmsDatasetRole" NOT NULL DEFAULT 'reader',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "CmsDatasetGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CmsDocument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "native_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "logicalId" TEXT NOT NULL,
    "variant" "CmsDocumentVariant" NOT NULL,
    "slug" TEXT,
    "locale" TEXT,
    "currentRevisionId" UUID,
    "lockVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "CmsDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsDocument_identity_check" CHECK (length("native_id") > 0 AND length("type") > 0 AND length("logicalId") > 0),
    CONSTRAINT "CmsDocument_lockVersion_check" CHECK ("lockVersion" >= 0)
);

CREATE TABLE "CmsMutation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CmsMutation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsMutation_request_check" CHECK (length("key") > 0 AND length("operation") > 0 AND "requestSha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "CmsRevision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "nativeRev" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sourceRev" TEXT,
    "sourceCreatedAt" TEXT,
    "sourceUpdatedAt" TEXT,
    "payload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "sourceRecordRaw" TEXT,
    "sourceSha256" TEXT,
    "provenance" JSONB,
    "actorId" UUID,
    "mutationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CmsRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsRevision_version_check" CHECK ("sequence" > 0 AND "schemaVersion" > 0 AND length("nativeRev") > 0),
    CONSTRAINT "CmsRevision_payload_check" CHECK (jsonb_typeof("payload") = 'object' AND "payloadSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CmsRevision_source_check" CHECK (
        ("sourceRecordRaw" IS NULL AND "sourceSha256" IS NULL) OR
        ("sourceRecordRaw" IS NOT NULL AND "sourceSha256" IS NOT NULL AND "sourceSha256" ~ '^[0-9a-f]{64}$')
    )
);

CREATE TABLE "CmsReference" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "sourceRevisionId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "weak" BOOLEAN NOT NULL DEFAULT false,
    "state" "CmsReferenceState" NOT NULL DEFAULT 'unresolved',
    "targetDocumentId" UUID,
    "diagnosticCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CmsReference_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsReference_path_check" CHECK ("path" = '' OR left("path", 1) = '/'),
    CONSTRAINT "CmsReference_resolution_check" CHECK (
        ("state" = 'resolved' AND "targetDocumentId" IS NOT NULL AND length("sourceRef") > 0) OR
        ("state" <> 'resolved' AND "targetDocumentId" IS NULL)
    ),
    CONSTRAINT "CmsReference_empty_check" CHECK (length("sourceRef") > 0 OR "state" = 'invalid')
);

CREATE UNIQUE INDEX "CmsDataset_organizationId_key_environment_key" ON "CmsDataset"("organizationId", "key", "environment");
CREATE INDEX "CmsDataset_siteId_organizationId_idx" ON "CmsDataset"("siteId", "organizationId");
CREATE UNIQUE INDEX "CmsDatasetGrant_datasetId_userId_key" ON "CmsDatasetGrant"("datasetId", "userId");
CREATE INDEX "CmsDatasetGrant_userId_idx" ON "CmsDatasetGrant"("userId");
CREATE UNIQUE INDEX "CmsDocument_datasetId_native_id_key" ON "CmsDocument"("datasetId", "native_id");
CREATE UNIQUE INDEX "CmsDocument_datasetId_logicalId_variant_key" ON "CmsDocument"("datasetId", "logicalId", "variant");
CREATE UNIQUE INDEX "CmsDocument_datasetId_id_key" ON "CmsDocument"("datasetId", "id");
CREATE UNIQUE INDEX "CmsDocument_datasetId_id_native_id_key" ON "CmsDocument"("datasetId", "id", "native_id");
CREATE INDEX "CmsDocument_datasetId_type_variant_idx" ON "CmsDocument"("datasetId", "type", "variant");
CREATE INDEX "CmsDocument_datasetId_type_locale_slug_idx" ON "CmsDocument"("datasetId", "type", "locale", "slug");
CREATE INDEX "CmsDocument_datasetId_id_currentRevisionId_idx" ON "CmsDocument"("datasetId", "id", "currentRevisionId");
CREATE UNIQUE INDEX "CmsMutation_datasetId_id_key" ON "CmsMutation"("datasetId", "id");
CREATE UNIQUE INDEX "CmsMutation_datasetId_key_key" ON "CmsMutation"("datasetId", "key");
CREATE INDEX "CmsMutation_actorId_idx" ON "CmsMutation"("actorId");
CREATE UNIQUE INDEX "CmsRevision_datasetId_id_key" ON "CmsRevision"("datasetId", "id");
CREATE UNIQUE INDEX "CmsRevision_datasetId_documentId_id_key" ON "CmsRevision"("datasetId", "documentId", "id");
CREATE UNIQUE INDEX "CmsRevision_datasetId_documentId_sequence_key" ON "CmsRevision"("datasetId", "documentId", "sequence");
CREATE UNIQUE INDEX "CmsRevision_datasetId_nativeRev_key" ON "CmsRevision"("datasetId", "nativeRev");
CREATE INDEX "CmsRevision_actorId_idx" ON "CmsRevision"("actorId");
CREATE INDEX "CmsRevision_datasetId_mutationId_idx" ON "CmsRevision"("datasetId", "mutationId");
CREATE UNIQUE INDEX "CmsReference_datasetId_sourceRevisionId_path_key" ON "CmsReference"("datasetId", "sourceRevisionId", "path");
CREATE INDEX "CmsReference_datasetId_targetDocumentId_sourceRef_idx" ON "CmsReference"("datasetId", "targetDocumentId", "sourceRef");
CREATE INDEX "CmsReference_datasetId_state_idx" ON "CmsReference"("datasetId", "state");

ALTER TABLE "CmsDataset" ADD CONSTRAINT "CmsDataset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- MATCH SIMPLE intentionally permits siteId=NULL, but binds every non-null site
-- to this exact organization. Site ownership moves are consequently restricted.
ALTER TABLE "CmsDataset" ADD CONSTRAINT "CmsDataset_siteId_organizationId_fkey" FOREIGN KEY ("siteId", "organizationId") REFERENCES "Site"("id", "organizationId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsDatasetGrant" ADD CONSTRAINT "CmsDatasetGrant_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsDatasetGrant" ADD CONSTRAINT "CmsDatasetGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsDocument" ADD CONSTRAINT "CmsDocument_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsMutation" ADD CONSTRAINT "CmsMutation_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsMutation" ADD CONSTRAINT "CmsMutation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsRevision" ADD CONSTRAINT "CmsRevision_datasetId_documentId_fkey" FOREIGN KEY ("datasetId", "documentId") REFERENCES "CmsDocument"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsRevision" ADD CONSTRAINT "CmsRevision_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsRevision" ADD CONSTRAINT "CmsRevision_datasetId_mutationId_fkey" FOREIGN KEY ("datasetId", "mutationId") REFERENCES "CmsMutation"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsDocument" ADD CONSTRAINT "CmsDocument_datasetId_id_currentRevisionId_fkey" FOREIGN KEY ("datasetId", "id", "currentRevisionId") REFERENCES "CmsRevision"("datasetId", "documentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsReference" ADD CONSTRAINT "CmsReference_datasetId_sourceRevisionId_fkey" FOREIGN KEY ("datasetId", "sourceRevisionId") REFERENCES "CmsRevision"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Includes exact sourceRef, not just target UUID: a differently spelled _ref
-- cannot accidentally be resolved to another identity in the same dataset.
ALTER TABLE "CmsReference" ADD CONSTRAINT "CmsReference_datasetId_targetDocumentId_sourceRef_fkey" FOREIGN KEY ("datasetId", "targetDocumentId", "sourceRef") REFERENCES "CmsDocument"("datasetId", "id", "native_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma cannot represent these triggers. Revisions and successful mutation
-- receipts are append-only, including no-op UPDATEs and table-wide TRUNCATE.
CREATE FUNCTION "cms_reject_immutable_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "CmsRevision_immutable" BEFORE UPDATE OR DELETE ON "CmsRevision"
FOR EACH ROW EXECUTE FUNCTION "cms_reject_immutable_change"();
CREATE TRIGGER "CmsRevision_no_truncate" BEFORE TRUNCATE ON "CmsRevision"
FOR EACH STATEMENT EXECUTE FUNCTION "cms_reject_immutable_change"();
CREATE TRIGGER "CmsMutation_immutable" BEFORE UPDATE OR DELETE ON "CmsMutation"
FOR EACH ROW EXECUTE FUNCTION "cms_reject_immutable_change"();
CREATE TRIGGER "CmsMutation_no_truncate" BEFORE TRUNCATE ON "CmsMutation"
FOR EACH STATEMENT EXECUTE FUNCTION "cms_reject_immutable_change"();

CREATE FUNCTION "cms_protect_document_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW."id", NEW."datasetId", NEW."native_id", NEW."type", NEW."logicalId", NEW."variant")
       IS DISTINCT FROM ROW(OLD."id", OLD."datasetId", OLD."native_id", OLD."type", OLD."logicalId", OLD."variant") THEN
        RAISE EXCEPTION 'CmsDocument identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "CmsDocument_identity_immutable" BEFORE UPDATE ON "CmsDocument"
FOR EACH ROW EXECUTE FUNCTION "cms_protect_document_identity"();

COMMIT;