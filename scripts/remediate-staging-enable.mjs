#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const cliSlugs = process.argv
  .slice(2)
  .filter((value) => value !== "--apply")
  .map((value) => value.trim())
  .filter(Boolean);

const envSlugs = (process.env.STAGING_ENABLE_SLUGS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const slugs = Array.from(new Set([...cliSlugs, ...envSlugs]));

if (slugs.length === 0) {
  console.error("No target slugs provided. Pass slugs as CLI args or STAGING_ENABLE_SLUGS=slug1,slug2");
  process.exit(1);
}

(async () => {
  try {
    const sites = await prisma.site.findMany({
      where: {
        deletedAt: null,
        slug: { in: slugs }
      },
      select: {
        id: true,
        slug: true,
        name: true,
        stagingEnabled: true,
        coolifyServiceUuid: true,
        organization: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: { slug: "asc" }
    });

    const foundSlugs = new Set(sites.map((site) => site.slug).filter(Boolean));
    const missing = slugs.filter((slug) => !foundSlugs.has(slug));

    if (missing.length > 0) {
      console.log("Missing slugs (not found):", missing.join(", "));
    }

    if (sites.length === 0) {
      console.log("No matching sites found. Nothing to do.");
      return;
    }

    const toEnable = sites.filter((site) => !site.stagingEnabled);
    const alreadyEnabled = sites.filter((site) => site.stagingEnabled);

    console.log(`Targets found: ${sites.length}`);
    console.log(`Already enabled: ${alreadyEnabled.length}`);
    console.log(`Needs enable: ${toEnable.length}`);

    if (toEnable.length > 0) {
      console.log("\nSites requiring staging enable:");
      for (const site of toEnable) {
        console.log(
          `- ${site.slug} (${site.name}) org=${site.organization.name} linked=${Boolean(site.coolifyServiceUuid)}`
        );
      }
    }

    if (!APPLY) {
      console.log("\nDry-run only. Re-run with --apply to set stagingEnabled=true for the listed sites.");
      process.exitCode = toEnable.length > 0 ? 2 : 0;
      return;
    }

    if (toEnable.length === 0) {
      console.log("Nothing to update.");
      return;
    }

    const ids = toEnable.map((site) => site.id);
    const result = await prisma.site.updateMany({
      where: { id: { in: ids } },
      data: { stagingEnabled: true }
    });

    console.log(`Updated rows: ${result.count}`);
    console.log("Applied stagingEnabled=true for requested remediation batch.");
  } finally {
    await prisma.$disconnect();
  }
})().catch(async (error) => {
  console.error("remediate-staging-enable failed:", error.message);
  try {
    await prisma.$disconnect();
  } catch {
    // noop
  }
  process.exit(1);
});
