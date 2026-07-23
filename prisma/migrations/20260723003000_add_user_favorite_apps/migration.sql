CREATE TABLE "UserFavoriteApp" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "appId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserFavoriteApp_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserFavoriteApp_userId_appId_key"
  ON "UserFavoriteApp"("userId", "appId");

CREATE INDEX "UserFavoriteApp_userId_idx"
  ON "UserFavoriteApp"("userId");

CREATE INDEX "UserFavoriteApp_appId_idx"
  ON "UserFavoriteApp"("appId");
