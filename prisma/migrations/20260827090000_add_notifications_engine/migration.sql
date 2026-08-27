-- TSK-00951: Admin Communications & Notification Engine.
-- Additive only: new enums, three new tables, two new columns on
-- UserProfileSettings.

CREATE TYPE "NotificationType" AS ENUM ('system_backup', 'suspension', 'maintenance', 'general');
CREATE TYPE "NotificationDeliveryMode" AS ENUM ('in_app', 'email', 'in_app_and_email');

ALTER TABLE "UserProfileSettings"
  ADD COLUMN "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "backupAlertsEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "NotificationTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "templateKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationTemplate_templateKey_key" ON "NotificationTemplate"("templateKey");

CREATE TABLE "NotificationBroadcast" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "createdBy" UUID NOT NULL,
    "templateKey" TEXT,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "deliveryMode" "NotificationDeliveryMode" NOT NULL DEFAULT 'in_app',
    "recipientScope" JSONB NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "emailSentCount" INTEGER NOT NULL DEFAULT 0,
    "emailFailedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationBroadcast_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationBroadcast_createdAt_idx" ON "NotificationBroadcast"("createdAt");

ALTER TABLE "NotificationBroadcast" ADD CONSTRAINT "NotificationBroadcast_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "clientId" UUID,
    "appId" UUID,
    "broadcastId" UUID,
    "type" "NotificationType" NOT NULL DEFAULT 'general',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_userId_dismissedAt_createdAt_idx" ON "Notification"("userId", "dismissedAt", "createdAt");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
CREATE INDEX "Notification_broadcastId_idx" ON "Notification"("broadcastId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_appId_fkey"
  FOREIGN KEY ("appId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_broadcastId_fkey"
  FOREIGN KEY ("broadcastId") REFERENCES "NotificationBroadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the three built-in composer templates. bodyTemplate supports
-- {{client_name}}, {{app_name}} and {{action_link}} placeholders, substituted
-- per-recipient at send time (see lib/notifications.ts).
INSERT INTO "NotificationTemplate" ("templateKey", "subject", "bodyTemplate", "updatedAt") VALUES
  ('suspension_notice', 'Action required: {{client_name}} account overdue',
   'Hi {{client_name}}, your account has an outstanding balance and requires action to avoid service interruption. Please review and resolve this at your earliest convenience: {{action_link}}',
   CURRENT_TIMESTAMP),
  ('maintenance_notice', 'Scheduled maintenance for {{app_name}}',
   'Hi {{client_name}}, we have scheduled maintenance for {{app_name}}. Some brief downtime may occur during this window. Details: {{action_link}}',
   CURRENT_TIMESTAMP),
  ('custom_announcement', 'A message from Jongo',
   'Hi {{client_name}}, {{action_link}}',
   CURRENT_TIMESTAMP)
ON CONFLICT ("templateKey") DO NOTHING;
