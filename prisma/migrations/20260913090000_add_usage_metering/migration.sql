-- Resource usage metering: hourly per-app buckets, hourly host totals, and the
-- counter state used to turn cumulative kernel counters into deltas.
-- Additive only.

CREATE TABLE "UsageHourly" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hourStart" TIMESTAMP(3) NOT NULL,
    "host" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "siteId" UUID,
    "label" TEXT NOT NULL,
    "cpuCoreSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memSumBytes" BIGINT NOT NULL DEFAULT 0,
    "memSamples" INTEGER NOT NULL DEFAULT 0,
    "memPeakBytes" BIGINT NOT NULL DEFAULT 0,
    "netRxBytes" BIGINT NOT NULL DEFAULT 0,
    "netTxBytes" BIGINT NOT NULL DEFAULT 0,
    "egressBytes" BIGINT NOT NULL DEFAULT 0,
    "diskBytes" BIGINT,
    "containers" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageHourly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageHourly_hourStart_host_subjectKey_key" ON "UsageHourly"("hourStart", "host", "subjectKey");
CREATE INDEX "UsageHourly_siteId_hourStart_idx" ON "UsageHourly"("siteId", "hourStart");
CREATE INDEX "UsageHourly_hourStart_idx" ON "UsageHourly"("hourStart");

CREATE TABLE "UsageHostHourly" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hourStart" TIMESTAMP(3) NOT NULL,
    "host" TEXT NOT NULL,
    "coveredSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cpuCores" INTEGER NOT NULL,
    "cpuBusySeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memTotalBytes" BIGINT NOT NULL,
    "memUsedSumBytes" BIGINT NOT NULL DEFAULT 0,
    "memSamples" INTEGER NOT NULL DEFAULT 0,
    "memUsedPeakBytes" BIGINT NOT NULL DEFAULT 0,
    "netRxBytes" BIGINT NOT NULL DEFAULT 0,
    "netTxBytes" BIGINT NOT NULL DEFAULT 0,
    "diskTotalBytes" BIGINT NOT NULL,
    "diskUsedBytes" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageHostHourly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageHostHourly_hourStart_host_key" ON "UsageHostHourly"("hourStart", "host");
CREATE INDEX "UsageHostHourly_hourStart_idx" ON "UsageHostHourly"("hourStart");

CREATE TABLE "UsageCounterState" (
    "key" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "cpuUsec" BIGINT NOT NULL DEFAULT 0,
    "netRxBytes" BIGINT NOT NULL DEFAULT 0,
    "netTxBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounterState_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "UsageCounterState_collectedAt_idx" ON "UsageCounterState"("collectedAt");
