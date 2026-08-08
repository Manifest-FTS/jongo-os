#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseEnvLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const separator = trimmed.indexOf("=");
  if (separator < 1) return null;
  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvOverrides() {
  // Order matters: app-local overrides repo-local, which overrides repo default.
  const files = [".env", ".env.local", "apps/web/.env.local"];
  for (const relative of files) {
    const absolute = path.join(process.cwd(), relative);
    if (!fsSync.existsSync(absolute)) continue;
    const content = fsSync.readFileSync(absolute, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      process.env[parsed.key] = parsed.value;
    }
  }
}

function isLikelyStagingEnvironmentName(name) {
  const value = normalize(name);
  if (!value) return false;
  return value.includes("stag") || value.includes("preview") || value === "dev";
}

function isLikelyStagingName(name) {
  const value = normalize(name);
  if (!value) return false;
  return /(^|[.\-_\s])(staging|stage|stg|preview|dev)([.\-_\s]|$)/.test(value);
}

function stripStagingAffixes(name) {
  return normalize(name)
    .replace(/^staging[.\-_\s]+/, "")
    .replace(/[.\-_\s]+staging$/, "")
    .replace(/^stg[.\-_\s]+/, "")
    .replace(/[.\-_\s]+stg$/, "")
    .trim();
}

function projectIdOf(resource) {
  return String(
    resource.project_uuid ||
      resource.project_id ||
      resource?.environment?.project?.uuid ||
      resource?.destination?.server?.project_uuid ||
      ""
  );
}

function environmentIdOf(resource) {
  const raw = resource.environment_id ?? resource.environmentId;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

async function coolifyGet(pathname) {
  const base = (process.env.COOLIFY_API_BASE_URL || "").replace(/\/+$/, "");
  const token = (process.env.COOLIFY_API_TOKEN || "").trim();
  if (!base || !token) {
    throw new Error("COOLIFY_API_BASE_URL and COOLIFY_API_TOKEN are required");
  }

  const response = await fetch(`${base}/api/v1${pathname}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Coolify ${pathname} failed (${response.status}): ${text.slice(0, 240)}`);
  }

  return response.json().catch(() => []);
}

async function buildProjectAndEnvironmentIndex() {
  const environmentNameById = new Map();
  const projectNameById = new Map();
  const warnings = [];

  try {
    const projects = await coolifyGet("/projects");
    for (const project of Array.isArray(projects) ? projects : []) {
      const projectUuid = String(project?.uuid || project?.id || "");
      if (!projectUuid) continue;

      const projectName = String(project?.name || project?.human_name || projectUuid);
      projectNameById.set(projectUuid, projectName);

      try {
        const detail = await coolifyGet(`/projects/${encodeURIComponent(projectUuid)}`);
        const environments = Array.isArray(detail?.environments) ? detail.environments : [];
        for (const environment of environments) {
          const numericId = Number(environment?.id);
          if (Number.isFinite(numericId)) {
            environmentNameById.set(numericId, String(environment?.name || ""));
          }
        }
      } catch {
        // Environment names are helpful but optional; continue with partial data.
      }
    }
  } catch (error) {
    warnings.push(`projects index unavailable: ${error?.message || error}`);
  }

  return { environmentNameById, projectNameById, warnings };
}

async function buildLiveResources() {
  const { environmentNameById, projectNameById, warnings } = await buildProjectAndEnvironmentIndex();

  const endpoints = [
    { kind: "service", path: "/services" },
    { kind: "application", path: "/applications" },
    { kind: "database", path: "/databases" }
  ];

  const resources = [];

  for (const endpoint of endpoints) {
    let rows = [];
    try {
      const payload = await coolifyGet(endpoint.path);
      rows = Array.isArray(payload) ? payload : [];
    } catch (error) {
      warnings.push(`${endpoint.path} unavailable: ${error?.message || error}`);
      continue;
    }

    for (const row of rows) {
      const uuid = String(row?.uuid || row?.id || "");
      if (!uuid) continue;

      const projectId = projectIdOf(row);
      const environmentId = environmentIdOf(row);
      const environmentName =
        String(row?.environment_name || row?.environment?.name || "") ||
        (environmentId !== undefined ? environmentNameById.get(environmentId) || "" : "");
      const name = String(row?.name || row?.human_name || uuid);
      const isStagingResource = isLikelyStagingEnvironmentName(environmentName) || isLikelyStagingName(name);

      resources.push({
        uuid,
        name,
        kind: endpoint.kind,
        projectId: projectId || undefined,
        projectName: projectId ? projectNameById.get(projectId) || undefined : undefined,
        environmentId,
        environmentName: environmentName || undefined,
        isStagingResource
      });
    }
  }

  return { resources, warnings };
}

function buildPairingIndex(resources) {
  const byPairKey = new Map();

  for (const resource of resources) {
    if (resource.isStagingResource) continue;
    const baseName = stripStagingAffixes(resource.name) || normalize(resource.name);
    const key = `${normalize(resource.projectId) || "no-project"}|${baseName}`;
    if (!byPairKey.has(key)) {
      byPairKey.set(key, resource);
    }
  }

  return byPairKey;
}

function dateDiffDays(isoValue) {
  if (!isoValue) return null;
  const time = new Date(isoValue).getTime();
  if (!Number.isFinite(time)) return null;
  const ms = Date.now() - time;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function printSummary(report) {
  const lines = [];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Coolify live resources: ${report.summary.coolifyLiveTotal}`);
  lines.push(`Directory-visible resources (production/non-staging): ${report.summary.coolifyVisibleTotal}`);
  lines.push(`Hidden staging counterparts: ${report.summary.coolifyStagingTotal}`);
  lines.push(`Staging singletons (no production pair found): ${report.summary.stagingSingletons}`);
  lines.push(`DB sites: ${report.summary.dbSitesTotal}`);
  lines.push(`DB mapped to live Coolify: ${report.summary.dbMappedLive}`);
  lines.push(`DB stale mappings (UUID missing in Coolify): ${report.summary.dbStaleMappings}`);
  lines.push(`DB rows marked staging: ${report.summary.dbStagingRows}`);
  lines.push(`Review/removal candidates: ${report.summary.reviewRemovalCandidates}`);

  console.log(lines.join("\n"));

  if (report.dbStaleMappings.length > 0) {
    console.log("\nStale DB mappings (review/removal):");
    for (const row of report.dbStaleMappings) {
      const missingDays = row.missingForDays ?? "n/a";
      console.log(`- ${row.name} (${row.id}) uuid=${row.coolifyServiceUuid} missingForDays=${missingDays}`);
    }
  }

  if (report.stagingSingletons.length > 0) {
    console.log("\nLive staging singletons (investigate pairing):");
    for (const row of report.stagingSingletons) {
      const environment = row.environmentName || "unknown-env";
      console.log(`- ${row.name} (${row.uuid}) project=${row.projectId || "n/a"} env=${environment}`);
    }
  }
}

function buildReport(liveResources, dbSites, staleThresholdDays) {
  const liveByUuid = new Map(liveResources.map((resource) => [resource.uuid, resource]));

  const visibleResources = liveResources.filter((resource) => !resource.isStagingResource);
  const hiddenStagingResources = liveResources.filter((resource) => resource.isStagingResource);

  const pairingIndex = buildPairingIndex(visibleResources);
  const stagingSingletons = hiddenStagingResources
    .map((resource) => {
      const baseName = stripStagingAffixes(resource.name) || normalize(resource.name);
      const pairKey = `${normalize(resource.projectId) || "no-project"}|${baseName}`;
      const pairedProduction = pairingIndex.get(pairKey);
      return {
        ...resource,
        pairedProductionUuid: pairedProduction?.uuid,
        pairedProductionName: pairedProduction?.name,
        singleton: !pairedProduction
      };
    })
    .filter((resource) => resource.singleton);

  const dbMapped = dbSites.filter((site) => Boolean(site.coolifyServiceUuid));
  const dbMappedLive = dbMapped.filter((site) => liveByUuid.has(site.coolifyServiceUuid));
  const dbStaleMappings = dbMapped
    .filter((site) => !liveByUuid.has(site.coolifyServiceUuid))
    .map((site) => ({
      id: site.id,
      slug: site.slug,
      name: site.name,
      coolifyServiceUuid: site.coolifyServiceUuid,
      coolifyProjectId: site.coolifyProjectId,
      isStagingResource: site.isStagingResource,
      resourceMissingSince: site.resourceMissingSince,
      missingForDays: dateDiffDays(site.resourceMissingSince),
      recommendRemovalReview:
        Boolean(site.resourceMissingSince) &&
        Number.isFinite(dateDiffDays(site.resourceMissingSince)) &&
        (dateDiffDays(site.resourceMissingSince) || 0) >= staleThresholdDays
    }));

  const dbStagingRows = dbSites.filter((site) => site.isStagingResource);
  const reviewRemovalCandidates = dbStaleMappings.filter((site) => site.recommendRemovalReview);

  return {
    generatedAt: new Date().toISOString(),
    sourceOfTruth: "coolify",
    policy: {
      directoryVisibility: "non-staging resources only",
      stagingAccess: "via production app staging tab"
    },
    summary: {
      coolifyLiveTotal: liveResources.length,
      coolifyVisibleTotal: visibleResources.length,
      coolifyStagingTotal: hiddenStagingResources.length,
      stagingSingletons: stagingSingletons.length,
      dbSitesTotal: dbSites.length,
      dbMappedLive: dbMappedLive.length,
      dbStaleMappings: dbStaleMappings.length,
      dbStagingRows: dbStagingRows.length,
      reviewRemovalCandidates: reviewRemovalCandidates.length
    },
    liveVisibleResources: visibleResources,
    liveHiddenStagingResources: hiddenStagingResources,
    stagingSingletons,
    dbStaleMappings,
    dbMappedLive: dbMappedLive.map((site) => ({
      id: site.id,
      slug: site.slug,
      name: site.name,
      coolifyServiceUuid: site.coolifyServiceUuid,
      coolifyProjectId: site.coolifyProjectId
    })),
    reviewRemovalCandidates
  };
}

async function maybeWriteReport(outputPath, report) {
  if (!outputPath) return;
  const absolutePath = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(process.cwd(), outputPath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nReport written to ${absolutePath}`);
}

function printHelp() {
  console.log(`Usage: node ./scripts/coolify-inventory-report.mjs [options]

Options:
  --json                  Print full JSON report to stdout
  --out <path>            Write JSON report to a file
  --stale-days <number>   Days before stale rows become removal-review candidates (default: 7)
  --help                  Show this help
`);
}

function isUnknownSelectFieldError(error, fieldName) {
  const message = String(error?.message || "");
  return message.includes(`Unknown field \`${fieldName}\``);
}

async function readDbSites(prisma) {
  try {
    return await prisma.site.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        coolifyServiceUuid: true,
        coolifyProjectId: true,
        isStagingResource: true,
        resourceMissingSince: true
      },
      orderBy: { name: "asc" }
    });
  } catch (error) {
    const canRetryWithoutStagingColumns =
      isUnknownSelectFieldError(error, "isStagingResource") ||
      isUnknownSelectFieldError(error, "resourceMissingSince");

    if (!canRetryWithoutStagingColumns) {
      throw error;
    }

    const legacyRows = await prisma.site.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        coolifyServiceUuid: true,
        coolifyProjectId: true
      },
      orderBy: { name: "asc" }
    });

    return legacyRows.map((row) => ({
      ...row,
      isStagingResource: false,
      resourceMissingSince: null
    }));
  }
}

async function main() {
  loadEnvOverrides();

  if (hasFlag("--help")) {
    printHelp();
    return;
  }

  const staleDaysRaw = Number(argValue("--stale-days") || "7");
  const staleThresholdDays = Number.isFinite(staleDaysRaw) && staleDaysRaw >= 0
    ? Math.floor(staleDaysRaw)
    : 7;

  const { resources: liveResources, warnings } = await buildLiveResources();

  const prisma = new PrismaClient();
  let dbSites = [];
  try {
    dbSites = await readDbSites(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const report = buildReport(liveResources, dbSites, staleThresholdDays);
  report.warnings = warnings;
  printSummary(report);

  if (hasFlag("--json")) {
    console.log(`\n${JSON.stringify(report, null, 2)}`);
  }

  await maybeWriteReport(argValue("--out"), report);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
