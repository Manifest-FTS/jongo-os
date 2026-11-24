/**
 * Turn off two-step sign-in for one account that lost both its authenticator
 * app and its recovery codes. Also signs that account out everywhere.
 *
 *   npm run ops:reset-two-factor -- --email person@example.com           (dry run)
 *   npm run ops:reset-two-factor -- --email person@example.com --apply
 *
 * Confirm who is asking before running this: it removes the second step from
 * their sign-in. They can turn it back on in Settings → Security.
 */
import { pathToFileURL } from "node:url";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  const email = argValue("--email")?.trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!email) throw new Error("Pass --email <address>.");

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  try {
    const user = await db.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
      select: { id: true, totpEnabledAt: true }
    });
    if (!user) throw new Error(`No account found for ${email}.`);
    if (!user.totpEnabledAt) {
      console.log(`[reset-two-factor] two-step sign-in is already off for ${email}.`);
      return;
    }
    if (!apply) {
      console.log(`[reset-two-factor] dry run: would turn off two-step sign-in for ${email} (on since ${user.totpEnabledAt.toISOString()}). Re-run with --apply.`);
      return;
    }
    await db.user.update({
      where: { id: user.id },
      data: {
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
        totpPendingSecret: null,
        totpPendingAt: null,
        totpRecoveryCodes: [],
        sessionVersion: { increment: 1 }
      }
    });
    console.log(`[reset-two-factor] turned off two-step sign-in for ${email} and signed it out everywhere.`);
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[reset-two-factor] ${error.message}`);
    process.exit(1);
  });
}
