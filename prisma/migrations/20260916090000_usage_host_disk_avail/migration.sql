-- Free disk space per host-hour, so the Usage page can show disk use the way
-- df and Coolify's disk alert do (reserved blocks excluded) and the day's peak.
-- Nullable: hours recorded before this have no value. Additive only.

ALTER TABLE "UsageHostHourly" ADD COLUMN "diskAvailBytes" BIGINT;
ALTER TABLE "UsageHostHourly" ADD COLUMN "diskAvailMinBytes" BIGINT;
