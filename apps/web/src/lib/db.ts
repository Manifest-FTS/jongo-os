// Database client - pending Prisma initialization
// This will be populated after DATABASE_URL is configured and migrations are applied
// See docs/database-schema.md for schema definition

// import { PrismaClient } from "@prisma/client";
// const db = new PrismaClient();
// export default db;

// Placeholder for now to avoid build errors
export const db = null as any;

export async function ensureDb() {
  console.warn("Database client not yet initialized. Configure DATABASE_URL and run `npm run db:push`");
}

export async function closeDb() {
  console.warn("Database client not yet initialized.");
}
