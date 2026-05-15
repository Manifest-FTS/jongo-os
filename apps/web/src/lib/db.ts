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

function getDatabaseHost(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return "(DATABASE_URL missing)";
  }

  try {
    return new URL(databaseUrl).host;
  } catch {
    return "(DATABASE_URL invalid)";
  }
}

function isLikelyConnectivityError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorLike = error as { code?: string; message?: string };
  const code = errorLike.code?.toUpperCase();
  const message = (errorLike.message ?? "").toLowerCase();

  return (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ECONNRESET" ||
    message.includes("getaddrinfo") ||
    message.includes("connect econnrefused") ||
    message.includes("timed out") ||
    message.includes("network is unreachable")
  );
}

function logConnectivityGuidance(error: unknown): void {
  if (!isLikelyConnectivityError(error)) {
    return;
  }

  console.warn(
    `[jongo] Database connection failed for ${getDatabaseHost()}. If you are developing locally, start the SSH tunnel and point DATABASE_URL at localhost:5433. See docs/local-development.md.`,
    error
  );
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
  } catch (error) {
    logConnectivityGuidance(error);
    return null;
  }
}
