-- SFTP access per app. See docs/sftp-access-architecture.md.
--
-- Additive only. "password" holds cleartext deliberately: the dashboard reveals
-- the credential so an operator can hand it to a client, which a hash cannot
-- support. The SFTP service keeps its own hashed copy; this one exists only to
-- display, and is returned only to a caller who may already manage the app.

CREATE TABLE "SftpAccount" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "siteId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "homePath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "providerError" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRotatedAt" TIMESTAMP(3),

    CONSTRAINT "SftpAccount_pkey" PRIMARY KEY ("id")
);

-- Globally unique: SFTPGo usernames are global, so two sites must never be able
-- to claim the same one and hand a client access to the wrong volume.
CREATE UNIQUE INDEX "SftpAccount_username_key" ON "SftpAccount"("username");
CREATE INDEX "SftpAccount_siteId_idx" ON "SftpAccount"("siteId");

ALTER TABLE "SftpAccount" ADD CONSTRAINT "SftpAccount_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
