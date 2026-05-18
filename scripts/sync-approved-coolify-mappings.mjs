import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const OWNER_EMAIL = process.env.SYNC_OWNER_EMAIL || "devkev@manifestfts.com";
const OVERVIEW_URL = process.env.SYNC_OVERVIEW_URL || "https://jongo.manifest-fts.com/api/coolify/overview";

function loadEnvLocalIfPresent() {
  const envPath = path.resolve(process.cwd(), "apps/web/.env.local");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function asArray(input) {
  if (Array.isArray(input)) {
    return input;
  }

  if (input && typeof input === "object") {
    const objectInput = input;
    if (Array.isArray(objectInput.data)) {
      return objectInput.data;
    }
    if (Array.isArray(objectInput.items)) {
      return objectInput.items;
    }
    if (Array.isArray(objectInput.resources)) {
      return objectInput.resources;
    }
  }

  return [];
}

function joinApiUrl(base, route) {
  const trimmedBase = (base || "").replace(/\/+$/, "");
  const normalizedBase = trimmedBase.endsWith("/api") ? trimmedBase : `${trimmedBase}/api`;
  return `${normalizedBase}${route}`;
}

async function fetchCoolifyJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Coolify request failed for ${url}: ${response.status}`);
  }

  return response.json();
}

async function fetchOverviewFromCoolifyApi() {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("COOLIFY_API_BASE_URL and COOLIFY_API_TOKEN are required for Coolify API fallback");
  }

  const [applicationsPayload, projectsPayload] = await Promise.all([
    fetchCoolifyJson(joinApiUrl(baseUrl, "/v1/applications"), token),
    fetchCoolifyJson(joinApiUrl(baseUrl, "/v1/projects"), token)
  ]);

  const projects = asArray(projectsPayload);
  const projectsById = new Map(
    projects.map((project) => {
      const id = String(project.uuid || project.id || project.project_uuid || project.project_id || "");
      const name = String(project.name || project.project_name || project.display_name || id);
      return [id, name];
    }).filter((pair) => pair[0])
  );

  const environmentToProjectId = new Map();

  for (const project of projects) {
    const projectLookupId = String(project.uuid || project.id || "");
    if (!projectLookupId) {
      continue;
    }

    try {
      const detailPayload = await fetchCoolifyJson(joinApiUrl(baseUrl, `/v1/projects/${projectLookupId}`), token);
      const detail = Array.isArray(detailPayload) ? detailPayload[0] : detailPayload;
      const environments = asArray(detail?.environments);
      const resolvedProjectId = String(project.uuid || project.id || "");

      for (const environment of environments) {
        const envId = String(environment.id || environment.uuid || environment.environment_id || "");
        if (envId && resolvedProjectId) {
          environmentToProjectId.set(envId, resolvedProjectId);
        }
      }
    } catch {
      // Keep fallback best-effort. Missing env details should not block approved sync.
    }
  }

  const sites = asArray(applicationsPayload).map((app) => {
    const id = String(app.uuid || app.id || "");
    const directProjectId = String(app.project_uuid || app.project_id || app.project || "");
    const environmentId = String(app.environment_id || app.environment_uuid || app.environmentId || "");
    const projectId = directProjectId || environmentToProjectId.get(environmentId) || "";
    return {
      id,
      name: String(app.name || app.application_name || id),
      coolifyProjectId: projectId || undefined,
      coolifyProjectName: projectId ? projectsById.get(projectId) : undefined
    };
  }).filter((site) => site.id);

  return {
    mode: "live",
    sites
  };
}

const APPROVED_MAPPINGS = [
  {
    organizationName: "Manifest FTS",
    coolifyProjectId: "ip1hwipx8sn24rd0dni67lb0",
    coolifyProjectName: "Manifest FTS",
    apps: ["Jongo WebApp", "MTFS Brand"]
  },
  {
    organizationName: "Community Catalyst",
    coolifyProjectId: "kan91vl6yh1h3uoqeboy607f",
    coolifyProjectName: "Community Catalyst",
    apps: ["cc-empowermaps"]
  },
  {
    organizationName: "JoyFeed",
    coolifyProjectId: "cplzvcszywes0ayod4jk4hme",
    coolifyProjectName: "JoyFeed",
    apps: ["joyfeed.app"]
  },
  {
    organizationName: "Millenion Fitness",
    coolifyProjectId: "sndclvrx7rwe3zii9sm1fdt2",
    coolifyProjectName: "Millenion Fitness",
    apps: ["Millenion Fitness"]
  },
  {
    organizationName: "Daniel Kane",
    coolifyProjectId: "ank4te9xzy8nz96ivyot1aoj",
    coolifyProjectName: "Daniel Kane",
    apps: ["Daniel Kane", "a3th9r"]
  },
  {
    organizationName: "Emile De Meyer",
    coolifyProjectId: "ubw2fq966nic1bm0uwhq2bv5",
    coolifyProjectName: "Emile De Meyer",
    apps: ["freebling-app"]
  }
];

function normalize(value) {
  return (value || "").trim().toLowerCase();
}

function slugify(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

async function getUniqueSlug(prisma, baseSlug) {
  const slugBase = baseSlug || `org-${Math.random().toString(36).slice(2, 8)}`;
  let candidate = slugBase;
  let index = 1;

  while (true) {
    const existing = await prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing) {
      return candidate;
    }

    index += 1;
    candidate = `${slugBase}-${index}`.slice(0, 72);
  }
}

async function fetchOverview() {
  try {
    const response = await fetch(OVERVIEW_URL, {
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Overview request failed: ${response.status}`);
    }

    const body = await response.json();
    if (!body || !Array.isArray(body.sites)) {
      throw new Error("Overview response missing sites array");
    }

    return body;
  } catch {
    return fetchOverviewFromCoolifyApi();
  }
}

function resolveApprovedApps(overview) {
  const unresolved = [];
  const resolved = [];

  for (const mapping of APPROVED_MAPPINGS) {
    for (const appName of mapping.apps) {
      const matches = overview.sites.filter((site) => {
        return (
          normalize(site.name) === normalize(appName) &&
          normalize(site.coolifyProjectId) === normalize(mapping.coolifyProjectId)
        );
      });

      if (matches.length !== 1) {
        unresolved.push({
          organizationName: mapping.organizationName,
          appName,
          projectId: mapping.coolifyProjectId,
          reason: matches.length === 0 ? "not_found" : "multiple_matches"
        });
        continue;
      }

      resolved.push({
        organizationName: mapping.organizationName,
        coolifyProjectId: mapping.coolifyProjectId,
        coolifyProjectName: mapping.coolifyProjectName,
        site: matches[0]
      });
    }
  }

  return { resolved, unresolved };
}

async function main() {
  loadEnvLocalIfPresent();

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const overview = await fetchOverview();
  const { resolved, unresolved } = resolveApprovedApps(overview);

  console.log(`Mode: ${APPLY ? "apply" : "dry-run"}`);
  console.log(`Overview mode: ${overview.mode || "unknown"}, sites: ${overview.sites.length}`);
  console.log(`Approved app matches: ${resolved.length}`);
  if (resolved.length > 0) {
    console.log("Resolved app mappings:");
    for (const item of resolved) {
      console.log(`- ${item.organizationName} :: ${item.site.name} [${item.site.id}] project=${item.coolifyProjectId}`);
    }
  }

  if (unresolved.length > 0) {
    console.log("Unresolved approved app lookups:");
    for (const item of unresolved) {
      console.log(`- ${item.organizationName} :: ${item.appName} [${item.projectId}] => ${item.reason}`);
    }
  }

  if (!APPLY) {
    console.log("Dry-run only. Re-run with --apply to insert org links/sites.");
    return;
  }

  if (unresolved.length > 0) {
    throw new Error("Refusing to apply because one or more approved app lookups are unresolved");
  }

  const prisma = new PrismaClient();

  try {
    const owner = await prisma.user.findUnique({ where: { email: OWNER_EMAIL }, select: { id: true, email: true } });
    if (!owner) {
      throw new Error(`Owner user not found for email: ${OWNER_EMAIL}`);
    }

    let orgCreated = 0;
    let linkCreated = 0;
    let siteInserted = 0;
    let siteSkipped = 0;

    const byOrg = new Map();
    for (const entry of resolved) {
      const key = normalize(entry.organizationName);
      if (!byOrg.has(key)) {
        byOrg.set(key, {
          organizationName: entry.organizationName,
          coolifyProjectId: entry.coolifyProjectId,
          coolifyProjectName: entry.coolifyProjectName,
          sites: []
        });
      }
      byOrg.get(key).sites.push(entry.site);
    }

    for (const orgGroup of byOrg.values()) {
      let org = await prisma.organization.findFirst({
        where: { name: { equals: orgGroup.organizationName, mode: "insensitive" }, deletedAt: null },
        select: { id: true, slug: true, coolifyProjectId: true, coolifyProjectName: true }
      });

      if (!org) {
        const slug = await getUniqueSlug(prisma, slugify(orgGroup.organizationName));
        org = await prisma.organization.create({
          data: {
            slug,
            name: orgGroup.organizationName,
            ownerId: owner.id,
            description: "Imported from approved Coolify ownership mapping"
          },
          select: { id: true, slug: true, coolifyProjectId: true, coolifyProjectName: true }
        });
        orgCreated += 1;
      }

      const existingLink = await prisma.organizationCoolifyProjectLink.findUnique({
        where: {
          organizationId_coolifyProjectId: {
            organizationId: org.id,
            coolifyProjectId: orgGroup.coolifyProjectId
          }
        },
        select: { id: true }
      });

      if (!existingLink) {
        await prisma.organizationCoolifyProjectLink.create({
          data: {
            organizationId: org.id,
            coolifyProjectId: orgGroup.coolifyProjectId,
            coolifyProjectName: orgGroup.coolifyProjectName,
            isPrimary: true
          }
        });
        linkCreated += 1;
      }

      if (!org.coolifyProjectId) {
        await prisma.organization.update({
          where: { id: org.id },
          data: {
            coolifyProjectId: orgGroup.coolifyProjectId,
            coolifyProjectName: orgGroup.coolifyProjectName
          }
        });
      }

      for (const site of orgGroup.sites) {
        const existingByUuid = await prisma.site.findFirst({
          where: { coolifyServiceUuid: site.id, deletedAt: null },
          select: { id: true }
        });
        if (existingByUuid) {
          siteSkipped += 1;
          continue;
        }

        const siteSlug = slugify(site.name || site.id) || site.id;
        const existingByOrgSlug = await prisma.site.findUnique({
          where: { organizationId_slug: { organizationId: org.id, slug: siteSlug } },
          select: { id: true }
        });
        if (existingByOrgSlug) {
          siteSkipped += 1;
          continue;
        }

        await prisma.site.create({
          data: {
            organizationId: org.id,
            slug: siteSlug,
            name: site.name,
            coolifyServiceUuid: site.id,
            coolifyProjectId: site.coolifyProjectId || orgGroup.coolifyProjectId,
            coolifyProjectName: site.coolifyProjectName || orgGroup.coolifyProjectName,
            description: "Imported from approved Coolify ownership mapping"
          }
        });
        siteInserted += 1;
      }
    }

    console.log("Apply complete:");
    console.log(`- Organizations created: ${orgCreated}`);
    console.log(`- Project links created: ${linkCreated}`);
    console.log(`- Sites inserted: ${siteInserted}`);
    console.log(`- Sites skipped (existing): ${siteSkipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("sync-approved-coolify-mappings failed:", error.message);
  process.exit(1);
});
