-- Additive only. No configured database execution or imported approval claims.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
CREATE TYPE "CmsApprovedMediaStatus" AS ENUM ('pending', 'approved', 'revoked');
CREATE TABLE "CmsApprovedMedia" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "datasetId" UUID NOT NULL REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "nativeId" TEXT NOT NULL,
  "assetType" TEXT NOT NULL DEFAULT 'sanity.imageAsset',
  "objectKey" TEXT NOT NULL,
  "url" TEXT,
  "sha256" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "alt" TEXT NOT NULL,
  "caption" TEXT NOT NULL DEFAULT '',
  "status" "CmsApprovedMediaStatus" NOT NULL DEFAULT 'pending',
  "reviewerId" UUID REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "approvedAt" TIMESTAMP(3),
  "createdBy" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CmsApprovedMedia_identity_check" CHECK (
    length("nativeId") BETWEEN 1 AND 1024 AND left("nativeId", 7) <> 'drafts.'
    AND "assetType" = 'sanity.imageAsset'
    AND "objectKey" = "datasetId"::text || '/' || "id"::text || '/' || "sha256" || '.webp'),
  CONSTRAINT "CmsApprovedMedia_raster_check" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
    AND "mimeType" = 'image/webp'
    AND "width" BETWEEN 1 AND 16384 AND "height" BETWEEN 1 AND 16384
    AND "width"::bigint * "height"::bigint <= 40000000
    AND "byteSize" BETWEEN 1 AND 20971520),
  CONSTRAINT "CmsApprovedMedia_text_check" CHECK (
    length(btrim("alt")) BETWEEN 1 AND 300 AND length("caption") <= 5000),
  -- Origin allowlisting is enforced by the server service; SQL binds URL to the object key.
  CONSTRAINT "CmsApprovedMedia_url_check" CHECK ("url" IS NULL OR (
    "url" ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?/assets/'
    AND "url" = substring("url" FROM '^https://[^/]+') || '/assets/' || "objectKey")),
  CONSTRAINT "CmsApprovedMedia_approval_check" CHECK (
    ("status" = 'pending' AND "url" IS NULL AND "reviewerId" IS NULL AND "approvedAt" IS NULL) OR
    ("status" IN ('approved', 'revoked') AND "url" IS NOT NULL AND "reviewerId" IS NOT NULL
      AND "approvedAt" IS NOT NULL AND "approvedAt" >= "createdAt"))
);
CREATE UNIQUE INDEX "CmsApprovedMedia_objectKey_key" ON "CmsApprovedMedia"("objectKey");
CREATE UNIQUE INDEX "CmsApprovedMedia_datasetId_id_key" ON "CmsApprovedMedia"("datasetId", "id");
CREATE UNIQUE INDEX "CmsApprovedMedia_datasetId_nativeId_key" ON "CmsApprovedMedia"("datasetId", "nativeId");
CREATE INDEX "CmsApprovedMedia_datasetId_status_idx" ON "CmsApprovedMedia"("datasetId", "status");
CREATE FUNCTION "cms_protect_approved_media"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','url','reviewerId','approvedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','url','reviewerId','approvedAt']) OR
     NOT ((OLD."status" = 'pending' AND NEW."status" = 'approved') OR
          (OLD."status" = 'approved' AND NEW."status" = 'revoked'
           AND ROW(NEW."url",NEW."reviewerId",NEW."approvedAt") IS NOT DISTINCT FROM
               ROW(OLD."url",OLD."reviewerId",OLD."approvedAt"))) THEN
    RAISE EXCEPTION 'Invalid media transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CmsApprovedMedia_protected" BEFORE UPDATE ON "CmsApprovedMedia"
FOR EACH ROW EXECUTE FUNCTION "cms_protect_approved_media"();
CREATE TRIGGER "CmsApprovedMedia_no_delete" BEFORE DELETE ON "CmsApprovedMedia"
FOR EACH ROW EXECUTE FUNCTION "cms_reject_immutable_change"();
CREATE TRIGGER "CmsApprovedMedia_no_truncate" BEFORE TRUNCATE ON "CmsApprovedMedia"
FOR EACH STATEMENT EXECUTE FUNCTION "cms_reject_immutable_change"();
COMMIT;
