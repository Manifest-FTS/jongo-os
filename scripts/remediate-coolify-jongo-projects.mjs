#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");

function loadEnvOverrides() {
  for (const relative of [".env", ".env.local", "apps/web/.env.local"]) {
    const absolute = path.join(process.cwd(), relative);
    if (!fs.existsSync(absolute)) continue;
    for (const line of fs.readFileSync(absolute, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function slugify(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function looksLikeStagingName(name) {
  const normalized = normalize(name);
  return /(^|[.\-_\s])(staging|stage|stg|preview|dev)([.\-_\s]|$)/.test(normalized);
}

function scoreJongoRow(row) {
  let score = 0;
  if (!row.resourceMissingSince) score += 100;
  if (!row.isStagingResource) score += 40;
  if (String(row.name ?? "").includes(".")) score += 15;
  if (String(row.slug ?? "").includes(".")) score += 10;
  if (row.coolifyProjectId) score += 5;
  return score;
}

function sshArgs() {
  const host = process.env.JONGO_SSH_HOST || "5.78.216.68";
  const keyPath = process.env.JONGO_SSH_KEY || path.join(process.env.USERPROFILE || process.env.HOME || "", ".ssh", "jongo_tunnel_key");
  const args = [];
  if (keyPath && fs.existsSync(keyPath)) {
    args.push("-i", keyPath);
  }
  args.push(`${process.env.JONGO_SSH_USER || "root"}@${host}`);
  return args;
}

function queryCoolifyDb(sql) {
  const remoteCommand = "docker exec -i coolify-db psql -U coolify -d coolify -F '\t' -A -t";
  const output = execFileSync("ssh", [...sshArgs(), remoteCommand], { input: sql, encoding: "utf8" });
  return output.trim();
}

function parseTabRows(text, columns) {
  if (!text.trim()) return [];
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const values = line.split("\t");
      return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    });
}

function ensureUniqueSlug(baseSlug, existingSlugs) {
  const root = slugify(baseSlug) || "app";
  let candidate = root;
  let suffix = 2;
  while (existingSlugs.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${root.slice(0, Math.max(1, 60 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  existingSlugs.add(candidate);
  return candidate;
}

function buildProjectPlan(project, jongoRows, coolifyRows) {
  const jongoByUuid = new Map();
  const duplicateActions = [];
  for (const row of jongoRows) {
    const key = row.coolifyServiceUuid || `db:${row.id}`;
    const existing = jongoByUuid.get(key);
    if (!existing) {
      jongoByUuid.set(key, row);
      continue;
    }

    if (scoreJongoRow(row) > scoreJongoRow(existing)) {
      jongoByUuid.set(key, row);
      duplicateActions.push({ keep: row, drop: existing });
    } else {
      duplicateActions.push({ keep: existing, drop: row });
    }
  }

  const chosenRows = [...jongoByUuid.values()];
  const coolifyByUuid = new Map(coolifyRows.map((row) => [row.resource_uuid, row]));

  const staleRows = chosenRows.filter((row) => row.coolifyServiceUuid && !coolifyByUuid.has(row.coolifyServiceUuid));
  const missingCoolifyRows = coolifyRows.filter((row) => !chosenRows.some((site) => site.coolifyServiceUuid === row.resource_uuid));
  const importableRows = missingCoolifyRows.filter((row) => !looksLikeStagingName(row.resource_name));
  const skippedStagingRows = missingCoolifyRows.filter((row) => looksLikeStagingName(row.resource_name));
  const matchedRowsNeedingUpdate = chosenRows
    .filter((row) => row.coolifyServiceUuid && coolifyByUuid.has(row.coolifyServiceUuid))
    .map((row) => ({ row, coolify: coolifyByUuid.get(row.coolifyServiceUuid) }))
    .filter(({ row, coolify }) => {
      return row.coolifyProjectId !== project.coolifyProjectId
        || row.resourceMissingSince
        || Boolean(row.isStagingResource) !== looksLikeStagingName(coolify.resource_name);
    });

  return {
    project,
    staleRows,
    duplicateActions,
    importableRows,
    skippedStagingRows,
    matchedRowsNeedingUpdate
  };
}

function printPlan(plan) {
  console.log(`\n# ${plan.project.name} (${plan.project.slug})`);
  console.log(`Project UUID: ${plan.project.coolifyProjectId}`);
  console.log(`Stale rows to delete: ${plan.staleRows.length}`);
  console.log(`Duplicate rows to collapse: ${plan.duplicateActions.length}`);
  console.log(`Missing live resources to import: ${plan.importableRows.length}`);
  console.log(`Staging-like live resources skipped: ${plan.skippedStagingRows.length}`);
  console.log(`Matched rows needing metadata refresh: ${plan.matchedRowsNeedingUpdate.length}`);

  if (plan.staleRows.length > 0) {
    console.log("Stale Jongo rows:");
    for (const row of plan.staleRows) {
      console.log(`- delete ${row.name} | ${row.slug} | ${row.coolifyServiceUuid} | missingSince=${row.resourceMissingSince || 'n/a'}`);
    }
  }

  if (plan.duplicateActions.length > 0) {
    console.log("Duplicate UUID rows:");
    for (const pair of plan.duplicateActions) {
      console.log(`- keep ${pair.keep.name} | drop ${pair.drop.name} | uuid=${pair.keep.coolifyServiceUuid}`);
    }
  }

  if (plan.importableRows.length > 0) {
    console.log("Importable live resources:");
    for (const row of plan.importableRows) {
      console.log(`- import ${row.kind} | ${row.resource_name} | ${row.resource_uuid} | env=${row.environment_name}`);
    }
  }

  if (plan.skippedStagingRows.length > 0) {
    console.log("Skipped staging-like live resources:");
    for (const row of plan.skippedStagingRows) {
      console.log(`- skip ${row.kind} | ${row.resource_name} | ${row.resource_uuid}`);
    }
  }
}

async function applyPlan(prisma, plan, allSitesForOrg) {
  const existingSlugs = new Set(allSitesForOrg.map((site) => String(site.slug || "")).filter(Boolean));
  const deletedIds = new Set();

  for (const row of plan.staleRows) {
    await prisma.$executeRaw`UPDATE "Site" SET "deletedAt" = now(), "updatedAt" = now() WHERE id = ${row.id}::uuid`;
    deletedIds.add(row.id);
  }

  for (const pair of plan.duplicateActions) {
    if (deletedIds.has(pair.drop.id)) continue;
    await prisma.$executeRaw`UPDATE "Site" SET "deletedAt" = now(), "updatedAt" = now() WHERE id = ${pair.drop.id}::uuid`;
    deletedIds.add(pair.drop.id);
  }

  for (const { row, coolify } of plan.matchedRowsNeedingUpdate) {
    const stagingLike = looksLikeStagingName(coolify.resource_name);
    await prisma.$executeRaw`
      UPDATE "Site"
      SET "coolifyProjectId" = ${plan.project.coolifyProjectId},
          "coolifyProjectName" = ${plan.project.coolifyProjectName ?? plan.project.name},
          "resourceMissingSince" = NULL,
          "isStagingResource" = ${stagingLike},
          "updatedAt" = now()
      WHERE id = ${row.id}::uuid
    `;
  }

  for (const resource of plan.importableRows) {
    const slug = ensureUniqueSlug(resource.resource_name, existingSlugs);
    await prisma.site.create({
      data: {
        organizationId: plan.project.id,
        slug,
        name: resource.resource_name,
        description: null,
        coolifyServiceId: resource.resource_uuid,
        coolifyServiceUuid: resource.resource_uuid,
        coolifyProjectId: plan.project.coolifyProjectId,
        coolifyProjectName: plan.project.coolifyProjectName ?? plan.project.name,
        stagingEnabled: false,
        gitRepositoryUrl: null,
        isStagingResource: false,
        environments: {
          create: [
            { name: "production", isProductionLike: true, coolifyEnvironmentName: resource.environment_name || null },
            { name: "staging", isProductionLike: false, coolifyEnvironmentName: "staging" }
          ]
        }
      },
      select: { id: true }
    });
  }
}

async function main() {
  loadEnvOverrides();

  const clientFilter = argValue("--client");

  const prisma = new PrismaClient();
  let organizations;
  let sites;
  try {
    organizations = await prisma.$queryRawUnsafe(`
      select id, slug, name, "coolifyProjectId", "coolifyProjectName"
      from "Organization"
      where "deletedAt" is null
        and "coolifyProjectId" is not null
      order by name asc
    `);

    sites = await prisma.$queryRawUnsafe(`
      select s.id, s.slug, s.name, s."organizationId", s."coolifyServiceUuid", s."coolifyProjectId", coalesce(s."isStagingResource", false) as "isStagingResource", s."resourceMissingSince"
      from "Site" s
      where s."deletedAt" is null
      order by s.name asc
    `);
  } finally {
    await prisma.$disconnect();
  }

  const filteredOrganizations = organizations.filter((org) => {
    if (!clientFilter) return true;
    const needle = normalize(clientFilter);
    return normalize(org.name).includes(needle) || normalize(org.slug) === needle || normalize(org.coolifyProjectId) === needle;
  });

  const coolifySql = `
    select p.uuid as project_uuid, p.name as project_name, e.name as environment_name, 'application' as kind, a.uuid as resource_uuid, a.name as resource_name
    from applications a
    join environments e on a.environment_id = e.id
    join projects p on e.project_id = p.id
    union all
    select p.uuid as project_uuid, p.name as project_name, e.name as environment_name, 'service' as kind, s.uuid as resource_uuid, s.name as resource_name
    from services s
    join environments e on s.environment_id = e.id
    join projects p on e.project_id = p.id
    order by project_name, environment_name, kind, resource_name;
  `;
  const coolifyRows = parseTabRows(queryCoolifyDb(coolifySql), [
    "project_uuid",
    "project_name",
    "environment_name",
    "kind",
    "resource_uuid",
    "resource_name"
  ]);

  const plans = filteredOrganizations.map((org) => {
    const projectRows = coolifyRows.filter((row) => row.project_uuid === org.coolifyProjectId);
    const orgSites = sites.filter((site) => site.organizationId === org.id);
    return buildProjectPlan(org, orgSites, projectRows);
  });

  for (const plan of plans) {
    printPlan(plan);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to reconcile Jongo rows against Coolify.");
    return;
  }

  const prismaApply = new PrismaClient();
  try {
    for (const plan of plans) {
      const orgSites = sites.filter((site) => site.organizationId === plan.project.id);
      await applyPlan(prismaApply, plan, orgSites);
    }
  } finally {
    await prismaApply.$disconnect();
  }

  console.log("\nApply complete.");
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
