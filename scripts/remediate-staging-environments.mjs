#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const ownershipToken = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const coolifyBaseUrl = (process.env.COOLIFY_API_BASE_URL || "").trim().replace(/\/+$/, "");
const coolifyToken = (process.env.COOLIFY_API_TOKEN || "").trim();
const applyChanges = process.argv.includes("--apply");
const targetIds = process.argv
  .slice(2)
  .filter((value) => !value.startsWith("--"))
  .map((value) => value.trim())
  .filter(Boolean);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), "apps/web/.env.local"));

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: `Invalid JSON response: ${text.slice(0, 250)}` };
  }
}

function ownershipHeaders() {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${process.env.OWNERSHIP_SYNC_TOKEN}`
  };
}

function coolifyHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.COOLIFY_API_TOKEN}`
  };
}

async function discoverSites() {
  const res = await fetch(`${baseUrl}/api/sites/staging-targets?scope=linked`, {
    headers: ownershipHeaders(),
    redirect: "manual"
  });
  const body = await parseJsonResponse(res);
  if (res.status !== 200) {
    throw new Error(`Discovery failed ${res.status}: ${body?.error || "unknown error"}`);
  }

  return (Array.isArray(body?.sites) ? body.sites : [])
    .map((site) => site?.recommendedId)
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

async function readStaging(siteId) {
  const res = await fetch(`${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging`, {
    headers: ownershipHeaders(),
    redirect: "manual"
  });
  const body = await parseJsonResponse(res);
  return { status: res.status, body };
}

async function readProjectEnvironments(projectId) {
  const res = await fetch(`${coolifyBaseUrl}/api/v1/projects/${encodeURIComponent(projectId)}`, {
    headers: coolifyHeaders(),
    redirect: "manual"
  });
  const body = await parseJsonResponse(res);
  if (!res.ok) {
    return { ok: false, names: [], error: body?.message || body?.error || `HTTP ${res.status}` };
  }

  const environments = Array.isArray(body?.environments) ? body.environments : [];
  const names = environments
    .map((env) => {
      if (!env || typeof env !== "object") {
        return "";
      }
      const value = env.name ?? env.environment_name ?? "";
      return typeof value === "string" ? value.trim() : "";
    })
    .filter(Boolean);

  return { ok: true, names };
}

async function createStagingEnvironment(projectId) {
  const projectIdentifiers = [projectId];
  try {
    const projectRes = await fetch(`${coolifyBaseUrl}/api/v1/projects/${encodeURIComponent(projectId)}`, {
      headers: coolifyHeaders(),
      redirect: "manual"
    });
    const projectBody = await parseJsonResponse(projectRes);
    if (projectRes.ok) {
      const numericId = projectBody?.id;
      if ((typeof numericId === "number" || typeof numericId === "string") && `${numericId}` !== projectId) {
        projectIdentifiers.push(`${numericId}`);
      }
    }
  } catch {
    // Best effort.
  }

  const payloads = [
    { name: "staging" },
    { name: "staging", environment_name: "staging" }
  ];

  let lastFailure = { status: 0, error: "unknown" };

  for (const identifier of projectIdentifiers) {
    for (const payload of payloads) {
      const res = await fetch(`${coolifyBaseUrl}/api/v1/projects/${encodeURIComponent(identifier)}/environments`, {
        method: "POST",
        headers: coolifyHeaders(),
        body: JSON.stringify(payload),
        redirect: "manual"
      });

      if (res.ok) {
        return { ok: true, status: res.status, payload, projectIdentifier: identifier };
      }

      const body = await parseJsonResponse(res);
      const errorText = `${body?.message || body?.error || `HTTP ${res.status}`}`;
      lastFailure = { status: res.status, error: errorText };
      const message = errorText.toLowerCase();
      if (res.status === 409 || message.includes("already") || message.includes("exist")) {
        return { ok: true, status: res.status, payload, projectIdentifier: identifier, alreadyExists: true };
      }
    }
  }

  return { ok: false, status: lastFailure.status, error: lastFailure.error };
}

function normalizeResourceKind(value) {
  if (value === "application" || value === "service" || value === "database") {
    return value;
  }
  return "unknown";
}

async function run() {
  requireValue("OWNERSHIP_SYNC_TOKEN", process.env.OWNERSHIP_SYNC_TOKEN);
  requireValue("COOLIFY_API_BASE_URL", process.env.COOLIFY_API_BASE_URL);
  requireValue("COOLIFY_API_TOKEN", process.env.COOLIFY_API_TOKEN);

  const discovered = await discoverSites();
  const candidateIds = targetIds.length > 0 ? targetIds : discovered;
  const selected = [];

  for (const siteId of candidateIds) {
    const result = await readStaging(siteId);
    if (result.status !== 200) {
      selected.push({ siteId, eligible: false, reason: `staging endpoint failed (${result.status})` });
      continue;
    }

    const site = result.body?.site || {};
    const capability = result.body?.stagingCapability || {};
    const resourceKind = normalizeResourceKind(capability.resourceKind);
    const projectId = typeof site.coolifyProjectId === "string" ? site.coolifyProjectId.trim() : "";
    const stagingDetected = Boolean(capability.detected);
    const note = typeof capability.note === "string" ? capability.note : "";

    const eligible =
      Boolean(projectId) &&
      !stagingDetected &&
      resourceKind === "application" &&
      (note === "project_only_has_production_environment" || note === "no_staging_environment_in_project");

    selected.push({
      siteId,
      projectId,
      resourceKind,
      stagingDetected,
      note,
      eligible,
      reason: eligible ? "" : "not an application target or staging already detectable"
    });
  }

  const eligibleRows = selected.filter((row) => row.eligible);
  const projectIds = [...new Set(eligibleRows.map((row) => row.projectId).filter(Boolean))];

  console.log(`Targets scanned: ${selected.length}`);
  console.log(`Eligible application targets: ${eligibleRows.length}`);
  console.log(`Unique projects needing staging env: ${projectIds.length}`);

  for (const row of selected) {
    const status = row.eligible ? "eligible" : "skip";
    console.log(`[${status}] ${row.siteId} kind=${row.resourceKind} project=${row.projectId || "-"} note=${row.note || "-"}`);
  }

  if (!applyChanges) {
    console.log("Dry run only. Re-run with --apply to create staging environments in Coolify projects.");
    return;
  }

  let created = 0;
  let already = 0;
  let failed = 0;

  for (const projectId of projectIds) {
    const before = await readProjectEnvironments(projectId);
    const hasStagingBefore = before.names.some((name) => /stag|preview|dev/i.test(name));
    if (hasStagingBefore) {
      already += 1;
      console.log(`[project:${projectId}] already has staging-like env (${before.names.join(", ") || "none"})`);
      continue;
    }

    const create = await createStagingEnvironment(projectId);
    if (!create.ok) {
      failed += 1;
      console.log(`[project:${projectId}] failed to create staging environment (status=${create.status || "n/a"} error=${create.error || "unknown"})`);
      continue;
    }

    const after = await readProjectEnvironments(projectId);
    const hasStagingAfter = after.names.some((name) => /stag|preview|dev/i.test(name));
    if (hasStagingAfter) {
      if (create.alreadyExists) {
        already += 1;
      } else {
        created += 1;
      }
      console.log(`[project:${projectId}] ok via project=${create.projectIdentifier} envs=${after.names.join(", ")}`);
    } else {
      failed += 1;
      console.log(`[project:${projectId}] create returned ok but staging env still not detected`);
    }
  }

  console.log(`Summary: created=${created} already=${already} failed=${failed}`);
}

run().catch((error) => {
  console.error("remediate-staging-environments failed:", error.message);
  process.exit(1);
});
