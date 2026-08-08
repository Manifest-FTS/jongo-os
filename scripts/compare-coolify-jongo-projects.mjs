#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

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

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
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

function scoreJongoRow(row) {
  let score = 0;
  if (!row.resourceMissingSince) score += 100;
  if (!row.isStagingResource) score += 40;
  if (row.name.includes(".")) score += 15;
  if (row.slug?.includes(".")) score += 10;
  return score;
}

function isUiVisibleJongoRow(row) {
  return !row.resourceMissingSince && !row.isStagingResource;
}

function keyForCoolify(row) {
  return row.resource_uuid;
}

function summarizeProject(project, jongoRows, coolifyRows) {
  const jongoByUuid = new Map();
  const duplicateJongoRows = [];
  for (const row of jongoRows) {
    const key = row.coolifyServiceUuid || `db:${row.id}`;
    const existing = jongoByUuid.get(key);
    if (!existing) {
      jongoByUuid.set(key, row);
      continue;
    }

    const rowScore = scoreJongoRow(row);
    const existingScore = scoreJongoRow(existing);
    if (rowScore > existingScore) {
      jongoByUuid.set(key, row);
      duplicateJongoRows.push({ kept: row, dropped: existing });
      continue;
    }

    duplicateJongoRows.push({ kept: existing, dropped: row });
  }

  const coolifyByUuid = new Map(coolifyRows.map((row) => [keyForCoolify(row), row]));
  const jongoVisibleRows = [...jongoByUuid.values()];
  const jongoUiVisibleRows = jongoVisibleRows.filter(isUiVisibleJongoRow);

  const staleJongoOnly = jongoVisibleRows.filter((row) => row.coolifyServiceUuid && !coolifyByUuid.has(row.coolifyServiceUuid));
  const missingFromJongo = coolifyRows.filter((row) => !jongoVisibleRows.some((site) => site.coolifyServiceUuid === row.resource_uuid));
  const matched = jongoVisibleRows.filter((row) => row.coolifyServiceUuid && coolifyByUuid.has(row.coolifyServiceUuid));

  return {
    project,
    counts: {
      jongoRows: jongoRows.length,
      jongoVisibleRows: jongoVisibleRows.length,
      jongoUiVisibleRows: jongoUiVisibleRows.length,
      coolifyRows: coolifyRows.length,
      matched: matched.length,
      staleJongoOnly: staleJongoOnly.length,
      missingFromJongo: missingFromJongo.length,
      duplicateJongoRows: duplicateJongoRows.length
    },
    matched,
    staleJongoOnly,
    missingFromJongo,
    duplicateJongoRows
  };
}

async function main() {
  loadEnvOverrides();

  const clientFilter = argValue("--client");
  const json = hasFlag("--json");

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
      select s.id, s.slug, s.name, s."organizationId", s."coolifyServiceUuid", s."coolifyProjectId", s."isStagingResource", s."parentSiteId", s."resourceMissingSince"
      from "Site" s
      where s."deletedAt" is null
      order by s.name asc
    `);
  } finally {
    await prisma.$disconnect();
  }

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

  const orgById = new Map(organizations.map((org) => [org.id, org]));
  const filteredOrganizations = organizations.filter((org) => {
    if (!clientFilter) return true;
    const needle = normalize(clientFilter);
    return normalize(org.name).includes(needle) || normalize(org.slug) === needle || normalize(org.coolifyProjectId) === needle;
  });

  const reports = filteredOrganizations.map((org) => {
    const projectRows = coolifyRows.filter((row) => row.project_uuid === org.coolifyProjectId);
    const jongoRows = sites
      .filter((site) => site.organizationId === org.id)
      .map((site) => ({
        ...site,
        organizationName: org.name
      }));
    return summarizeProject(org, jongoRows, projectRows);
  });

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const report of reports) {
    console.log(`\n# ${report.project.name} (${report.project.slug})`);
    console.log(`Project UUID: ${report.project.coolifyProjectId}`);
    console.log(`Jongo rows: ${report.counts.jongoRows}`);
    console.log(`Jongo visible rows after UUID dedupe: ${report.counts.jongoVisibleRows}`);
    console.log(`Jongo UI-visible rows after stale/staging filter: ${report.counts.jongoUiVisibleRows}`);
    console.log(`Coolify live rows: ${report.counts.coolifyRows}`);
    console.log(`Matched: ${report.counts.matched}`);
    console.log(`Jongo-only stale/missing: ${report.counts.staleJongoOnly}`);
    console.log(`Coolify-only missing from Jongo: ${report.counts.missingFromJongo}`);
    console.log(`Duplicate Jongo UUID rows: ${report.counts.duplicateJongoRows}`);

    if (report.staleJongoOnly.length > 0) {
      console.log("Jongo-only rows:");
      for (const row of report.staleJongoOnly) {
        console.log(`- ${row.name} | ${row.slug} | ${row.coolifyServiceUuid} | missingSince=${row.resourceMissingSince || 'n/a'}`);
      }
    }

    if (report.missingFromJongo.length > 0) {
      console.log("Coolify-only live resources:");
      for (const row of report.missingFromJongo) {
        console.log(`- ${row.kind} | ${row.resource_name} | ${row.resource_uuid} | env=${row.environment_name}`);
      }
    }

    if (report.duplicateJongoRows.length > 0) {
      console.log("Duplicate Jongo UUID rows:");
      for (const pair of report.duplicateJongoRows) {
        console.log(`- kept=${pair.kept.name} dropped=${pair.dropped.name} uuid=${pair.kept.coolifyServiceUuid}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
