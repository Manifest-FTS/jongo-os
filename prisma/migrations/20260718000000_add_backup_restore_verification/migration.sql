-- Records end-to-end restore-test outcomes per Coolify database resource.
CREATE TABLE "BackupRestoreVerification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resourceUuid" TEXT NOT NULL,
    "lastResult" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
    "rpoHours" INTEGER NOT NULL DEFAULT 26,
    "restoreSeconds" INTEGER,
    "offsitePresent" TEXT,
    "rowsMatch" BOOLEAN,
    "rows" JSONB,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupRestoreVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BackupRestoreVerification_resourceUuid_key" ON "BackupRestoreVerification"("resourceUuid");
CREATE INDEX "BackupRestoreVerification_resourceUuid_idx" ON "BackupRestoreVerification"("resourceUuid");
