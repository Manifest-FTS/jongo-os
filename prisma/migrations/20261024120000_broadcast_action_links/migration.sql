-- Add an optional, labeled call-to-action to in-app notifications and broadcasts.
ALTER TABLE "Notification"
  ADD COLUMN "actionLinkLabel" TEXT,
  ADD COLUMN "actionLinkUrl" TEXT;

ALTER TABLE "NotificationBroadcast"
  ADD COLUMN "actionLinkLabel" TEXT,
  ADD COLUMN "actionLinkUrl" TEXT;