import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const rows = await p.$queryRawUnsafe(`
  SELECT s.slug, b.status, b.trigger, b."resourceType" rtype, b."volumeCount" vols,
         b."databaseCount" dbs, b."databaseTables" tables, b."sizeBytes" size,
         b."resticSnapshotId" snap, b.error, b."startedAt"
  FROM "SiteBackup" b JOIN "Site" s ON s.id=b."siteId"
  ORDER BY b."startedAt" DESC LIMIT 4`);
for (const r of rows) {
  console.log(`${r.startedAt.toISOString().slice(11,19)} ${String(r.slug).padEnd(24)} ${String(r.status).padEnd(8)} ${String(r.trigger).padEnd(10)} type=${r.rtype||"-"} vols=${r.vols??"-"} dbs=${r.dbs??"-"} TABLES=${r.tables??"null"} size=${r.size??"-"} snap=${r.snap||"-"} ${r.error||""}`);
}
await p.$disconnect();
