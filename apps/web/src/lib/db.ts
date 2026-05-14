const prismaClientModule = require("@prisma/client") as {
  PrismaClient: new (...args: unknown[]) => any;
};

const PrismaClient = prismaClientModule.PrismaClient;

const globalForPrisma = globalThis as unknown as {
  prisma?: any;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export async function ensureDb() {
  await db.$connect();
}

export async function closeDb() {
  await db.$disconnect();
}

/**
 * Returns the Prisma client if the generated client is available,
 * or null when running without a database (mock mode).
 */
export async function getDb(): Promise<typeof db | null> {
  try {
    // Quick ping to verify the client is actually usable
    await db.$queryRaw`SELECT 1`;
    return db;
  } catch {
    return null;
  }
}
