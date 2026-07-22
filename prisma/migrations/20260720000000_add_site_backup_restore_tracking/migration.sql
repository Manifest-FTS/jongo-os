-- Track restore runs against the backup they were restored from, so the UI can
-- report completion. All columns are nullable/additive — existing rows unaffected.
ALTER TABLE "SiteBackup"
ADD COLUMN "restoreStatus" TEXT,
ADD COLUMN "restoreStartedAt" TIMESTAMP(3),
ADD COLUMN "restoreCompletedAt" TIMESTAMP(3),
ADD COLUMN "restoreError" TEXT,
ADD COLUMN "safetySnapshotId" TEXT;