-- Private repositories on any Git host via deploy keys, with push webhooks.

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "gitDeployKeyId" UUID,
ADD COLUMN     "gitProvider" TEXT,
ADD COLUMN     "gitWebhookSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "GitDeployKey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "coolifyKeyUuid" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitDeployKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitDeployKey_coolifyKeyUuid_key" ON "GitDeployKey"("coolifyKeyUuid");

-- CreateIndex
CREATE INDEX "GitDeployKey_organizationId_idx" ON "GitDeployKey"("organizationId");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_gitDeployKeyId_fkey" FOREIGN KEY ("gitDeployKeyId") REFERENCES "GitDeployKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitDeployKey" ADD CONSTRAINT "GitDeployKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
