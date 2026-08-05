-- Stack-agnostic content summary for a backup.
--
-- The WordPress-shaped columns (posts/pages/plugins/comments/wpVersion) stay
-- where they are: they hold real history, the UI reads them, and a backfill is
-- not worth the risk. New stacks write their metrics here instead of adding a
-- column per framework, so supporting Nuxt does not mean a migration.
ALTER TABLE "SiteBackup" ADD COLUMN IF NOT EXISTS "contentSummary" JSONB;
