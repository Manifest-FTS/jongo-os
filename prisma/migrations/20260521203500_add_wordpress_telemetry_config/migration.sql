CREATE TABLE "WordPressTelemetryConfig" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "siteId" UUID NOT NULL,
  "siteUrl" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordCiphertext" TEXT NOT NULL,
  "lastTestedAt" TIMESTAMP(3),
  "lastTestStatus" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WordPressTelemetryConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WordPressTelemetryConfig_siteId_key" ON "WordPressTelemetryConfig"("siteId");
CREATE INDEX "WordPressTelemetryConfig_siteId_idx" ON "WordPressTelemetryConfig"("siteId");

ALTER TABLE "WordPressTelemetryConfig"
  ADD CONSTRAINT "WordPressTelemetryConfig_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
