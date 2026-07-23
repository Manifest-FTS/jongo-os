CREATE TABLE "UserProfileSettings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "username" TEXT,
  "profileRole" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "UserProfileSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserProfileSettings_userId_key" ON "UserProfileSettings"("userId");
CREATE UNIQUE INDEX "UserProfileSettings_username_key" ON "UserProfileSettings"("username");
CREATE INDEX "UserProfileSettings_username_idx" ON "UserProfileSettings"("username");

ALTER TABLE "UserProfileSettings"
ADD CONSTRAINT "UserProfileSettings_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
