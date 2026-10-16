import { PrismaClient } from '@prisma/client';

// Explicit maintenance operation, never an HTTP handler or environment bypass.
const db = new PrismaClient();
try {
  const matches = await db.user.findMany({
    where: { email: { equals: 'devkev@manifestfts.com', mode: 'insensitive' }, deletedAt: null },
    select: { id: true }
  });
  if (matches.length !== 1) throw new Error('Expected exactly one active target user; no role was changed.');
  await db.user.update({ where: { id: matches[0].id }, data: { role: 'super_admin' } });
  console.log('Super-admin seed completed.');
} catch {
  console.error('Super-admin seed failed; verify migrations and the target account.');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}