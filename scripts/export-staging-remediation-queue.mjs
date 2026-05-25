#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const outputFile = process.env.OUTPUT_FILE || "docs/workflows/staging-remediation-queue-latest.md";

if (!token) {
  console.error("Missing OWNERSHIP_SYNC_TOKEN.");
  process.exit(1);
}

function authHeaders() {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: `Invalid JSON response: ${text.slice(0, 250)}` };
  }
}

async function discoverSites() {
  const res = await fetch(`${baseUrl}/api/sites/staging-targets?scope=linked`, {
    headers: authHeaders(),
    redirect: "manual"
  });
  const body = await parseJsonResponse(res);
  if (res.status !== 200) {
    throw new Error(`Discovery failed ${res.status}: ${body?.error || "unknown error"}`);
  }

  const sites = Array.isArray(body?.sites) ? body.sites : [];
  return sites
    .map((site) => site?.recommendedId)
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

async function readStaging(siteId) {
  const res = await fetch(`${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging`, {
    headers: authHeaders(),
    redirect: "manual"
  });
  const body = await parseJsonResponse(res);
  return { status: res.status, body };
}

function formatList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "(none)";
  }
  return items.join("; ");
}

async function run() {
  const siteIds = await discoverSites();
  if (siteIds.length === 0) {
    throw new Error("No linked sites discovered.");
  }

  const rows = [];
  for (const siteId of siteIds) {
    const response = await readStaging(siteId);
    if (response.status !== 200) {
      rows.push({
        siteId,
        siteName: siteId,
        coolifyServiceUuid: "",
        coolifyProjectId: "",
        stagingDetected: false,
        stagingApplicationUuid: "",
        blockers: `staging endpoint failed (${response.status}): ${response.body?.error || "unknown"}`,
        suggestedActions: "Investigate API auth/access and retry."
      });
      continue;
    }

    const body = response.body || {};
    const site = body.site || {};
    const capability = body.stagingCapability || {};
    rows.push({
      siteId: site.slug || site.id || siteId,
      siteName: site.name || site.slug || site.id || siteId,
      coolifyServiceUuid: site.coolifyServiceUuid || "",
      coolifyProjectId: site.coolifyProjectId || "",
      resourceKind: capability.resourceKind || "unknown",
      projectEnvNames: Array.isArray(capability.projectEnvNames) ? capability.projectEnvNames : [],
      capabilityNote: capability.note || "",
      stagingDetected: Boolean(capability.detected),
      stagingApplicationUuid: capability.applicationUuid || "",
      blockers: formatList(body.blockers),
      suggestedActions: formatList(body.suggestedActions)
    });
  }

  const generatedAt = new Date().toISOString();
  const missingStaging = rows.filter((row) => !row.stagingDetected).length;
  const backupBlocked = rows.filter((row) => row.blockers.toLowerCase().includes("backups not configured")).length;

  const lines = [];
  lines.push("# Staging Remediation Queue (Latest)");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Base URL: ${baseUrl}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Linked apps scanned: ${rows.length}`);
  lines.push(`- Missing staging detection: ${missingStaging}`);
  lines.push(`- Backup blocker present: ${backupBlocked}`);
  lines.push("");
  lines.push("## Queue");
  lines.push("");
  lines.push("| App | Resource Kind | Coolify Service UUID | Coolify Project ID | Project Environments | Staging detected | Staging App UUID | Capability Note | Blockers | Suggested actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const row of rows) {
    lines.push(
      `| ${row.siteId} | ${row.resourceKind || "unknown"} | ${row.coolifyServiceUuid || "-"} | ${row.coolifyProjectId || "-"} | ${(row.projectEnvNames.length > 0 ? row.projectEnvNames.join(", ") : "-").replace(/\|/g, "\\|")} | ${row.stagingDetected ? "yes" : "no"} | ${row.stagingApplicationUuid || "-"} | ${(row.capabilityNote || "-").replace(/\|/g, "\\|")} | ${row.blockers.replace(/\|/g, "\\|")} | ${row.suggestedActions.replace(/\|/g, "\\|")} |`
    );
  }

  lines.push("");
  lines.push("## Immediate Ops Steps");
  lines.push("");
  lines.push("1. For rows with `Staging detected = no`, create or attach staging in Coolify using the listed service/project identifiers.");
  lines.push("2. For rows with `Backups not configured`, add at least one automated backup schedule in Coolify.");
  lines.push("3. Re-run strict smoke and regenerate this queue after each remediation batch.");

  const content = lines.join("\n");
  const resolvedOutput = path.resolve(process.cwd(), outputFile);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, content, "utf8");

  console.log(`Wrote remediation queue: ${outputFile}`);
  console.log(`Summary: linked=${rows.length} missingStaging=${missingStaging} backupBlocked=${backupBlocked}`);
}

run().catch((error) => {
  console.error("export-staging-remediation-queue failed:", error.message);
  process.exit(1);
});
