-- Additive, independently owned billing migration. No changes to User, CMS,
-- shared WebhookEvent, products, prices, or existing subscription values.
CREATE TABLE "StripeSubscriptionEvent" (
  "eventId" TEXT NOT NULL PRIMARY KEY,
  "eventType" TEXT NOT NULL,
  "eventCreated" INTEGER NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "userId" UUID,
  "outcome" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "StripeSubscriptionEvent_subscriptionId_eventCreated_idx"
  ON "StripeSubscriptionEvent" ("subscriptionId", "eventCreated");
CREATE TABLE "StripeSubscriptionState" (
  "subscriptionId" TEXT NOT NULL PRIMARY KEY,
  "customerId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "providerCreated" INTEGER NOT NULL,
  "eventCreated" INTEGER NOT NULL,
  "lastEventId" TEXT NOT NULL,
  "terminal" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "StripeSubscriptionState_userId_idx" ON "StripeSubscriptionState" ("userId");