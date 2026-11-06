-- "Sign in with Jongo" Phase 1b: the Craft role chosen when inviting someone to an app.
-- Additive only: one new table. "Invitation" itself is NOT altered (no column, index or constraint);
-- the only statement touching an existing table is the foreign key FROM the new table TO "Invitation"
-- (brief catalog lock, no rewrite, no data change). Rollback = leave the table unused.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- CreateTable
CREATE TABLE "InvitationCraftAccess" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invitationId" UUID NOT NULL,
    "role" "SiteCraftRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationCraftAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvitationCraftAccess_invitationId_key" ON "InvitationCraftAccess"("invitationId");

-- AddForeignKey
ALTER TABLE "InvitationCraftAccess" ADD CONSTRAINT "InvitationCraftAccess_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "Invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
