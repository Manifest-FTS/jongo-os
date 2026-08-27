-- TSK-00951 follow-up: correct seeded broadcast template copy.
--
-- Upsert rather than edit the original INSERT: the first migration may
-- already be applied to a database (this branch was live-tested before
-- merge), and Prisma checksums applied migration files -- editing one after
-- the fact breaks every future `migrate deploy` against that database with a
-- checksum mismatch. A new migration is always safe to apply.
--
-- Also introduces {{recipient_name}} as a distinct placeholder from
-- {{client_name}}: the person being addressed is not always the same as the
-- client/organization name (see lib/notifications.ts).
--
-- suspension_notice is reworded from a balance-overdue warning to an
-- already-suspended notice, since that is what the feature actually needed:
-- something to send once an account IS suspended, with the CTA being "resolve
-- this to restore access" rather than "avoid this happening".

INSERT INTO "NotificationTemplate" ("templateKey", "subject", "bodyTemplate", "updatedAt") VALUES
  ('suspension_notice', 'Action needed: your {{client_name}} account has been suspended',
   'Hi {{recipient_name}}, your {{client_name}} account has been suspended due to an outstanding balance, and access to your apps and services is currently paused. To restore access, please resolve the balance as soon as possible: {{action_link}}',
   CURRENT_TIMESTAMP),
  ('maintenance_notice', 'Scheduled maintenance for {{app_name}}',
   'Hi {{recipient_name}}, we have scheduled maintenance for {{app_name}}, part of your {{client_name}} account. Some brief downtime may occur during this window. Details: {{action_link}}',
   CURRENT_TIMESTAMP),
  ('custom_announcement', 'A message from Jongo',
   'Hi {{recipient_name}}, {{action_link}}',
   CURRENT_TIMESTAMP)
ON CONFLICT ("templateKey") DO UPDATE SET
  "subject" = EXCLUDED."subject",
  "bodyTemplate" = EXCLUDED."bodyTemplate",
  "updatedAt" = CURRENT_TIMESTAMP;
