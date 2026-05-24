#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const inputFile = process.env.INPUT_FILE || "docs/workflows/staging-remediation-queue-latest.md";
const outputFile = process.env.OUTPUT_FILE || "docs/workflows/staging-remediation-tracker-latest.md";

function parseQueueTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const rows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      continue;
    }

    if (trimmed.includes("| App | Coolify Service UUID |")) {
      continue;
    }

    if (trimmed.startsWith("| ---")) {
      continue;
    }

    const cols = trimmed
      .split("|")
      .map((value) => value.trim())
      .filter((value, index, arr) => !(index === 0 || index === arr.length - 1));

    if (cols.length < 7) {
      continue;
    }

    rows.push({
      app: cols[0],
      serviceUuid: cols[1] === "-" ? "" : cols[1],
      projectId: cols[2] === "-" ? "" : cols[2],
      stagingDetected: cols[3],
      stagingAppUuid: cols[4] === "-" ? "" : cols[4],
      blockers: cols[5],
      suggestedActions: cols[6]
    });
  }

  return rows;
}

function containsBackupBlocker(blockers) {
  return blockers.toLowerCase().includes("backups not configured");
}

function run() {
  const inputPath = path.resolve(process.cwd(), inputFile);
  const outputPath = path.resolve(process.cwd(), outputFile);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input queue file not found: ${inputFile}`);
  }

  const markdown = fs.readFileSync(inputPath, "utf8");
  const rows = parseQueueTable(markdown);

  if (rows.length === 0) {
    throw new Error("No queue rows found in input file.");
  }

  const stagingMissing = rows.filter((row) => row.stagingDetected !== "yes");
  const backupMissing = rows.filter((row) => containsBackupBlocker(row.blockers));
  const generatedAt = new Date().toISOString();

  const lines = [];
  lines.push("# Staging Remediation Tracker (Latest)");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Source queue: ${inputFile}`);
  lines.push("");
  lines.push("## Scope Summary");
  lines.push("");
  lines.push(`- Total apps in queue: ${rows.length}`);
  lines.push(`- Apps missing staging detection: ${stagingMissing.length}`);
  lines.push(`- Apps missing backups: ${backupMissing.length}`);
  lines.push("");
  lines.push("## Batch A: Staging Creation/Attach in Coolify");
  lines.push("");

  for (const row of stagingMissing) {
    lines.push(`- [ ] ${row.app} (service=${row.serviceUuid || "n/a"}, project=${row.projectId || "n/a"})`);
  }

  lines.push("");
  lines.push("## Batch B: Backup Schedule Configuration in Coolify");
  lines.push("");

  for (const row of backupMissing) {
    lines.push(`- [ ] ${row.app} (service=${row.serviceUuid || "n/a"}, project=${row.projectId || "n/a"})`);
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Mark each item as completed in this tracker as Coolify changes are applied.");
  lines.push("- After each batch, regenerate queue and smoke results:");
  lines.push("  - npm run ops:export-staging-remediation-queue");
  lines.push("  - npm run smoke:staging-promote");
  lines.push("- Keep this tracker and the queue artifact in sync.");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");

  console.log(`Wrote remediation tracker: ${outputFile}`);
  console.log(`Summary: total=${rows.length} stagingMissing=${stagingMissing.length} backupMissing=${backupMissing.length}`);
}

try {
  run();
} catch (error) {
  console.error("generate-staging-remediation-tracker failed:", error.message);
  process.exit(1);
}
