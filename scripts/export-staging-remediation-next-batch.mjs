#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const queueFile = process.env.QUEUE_FILE || "docs/workflows/staging-remediation-queue-latest.md";
const outputFile = process.env.OUTPUT_FILE || "docs/workflows/staging-remediation-next-batch.md";
const batchSizeRaw = process.env.BATCH_SIZE || "3";
const batchSize = Number.isFinite(Number(batchSizeRaw)) ? Math.max(1, Number(batchSizeRaw)) : 3;

function parseQueueRows(markdown) {
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
      stagingDetected: cols[3] === "yes",
      stagingAppUuid: cols[4] === "-" ? "" : cols[4],
      blockers: cols[5],
      suggestedActions: cols[6]
    });
  }

  return rows;
}

function hasBackupBlocker(row) {
  return row.blockers.toLowerCase().includes("backups not configured");
}

function main() {
  const queuePath = path.resolve(process.cwd(), queueFile);
  const outputPath = path.resolve(process.cwd(), outputFile);

  if (!fs.existsSync(queuePath)) {
    throw new Error(`Queue file not found: ${queueFile}`);
  }

  const rows = parseQueueRows(fs.readFileSync(queuePath, "utf8"));
  const stagingMissing = rows.filter((row) => !row.stagingDetected);
  const stagingOnly = stagingMissing.filter((row) => !hasBackupBlocker(row));
  const stagingPlusBackup = stagingMissing.filter((row) => hasBackupBlocker(row));

  const recommended = (stagingOnly.length > 0 ? stagingOnly : stagingMissing).slice(0, batchSize);
  const generatedAt = new Date().toISOString();

  const lines = [];
  lines.push("# Staging Remediation Next Batch");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Source queue: ${queueFile}`);
  lines.push(`Batch size: ${batchSize}`);
  lines.push("");
  lines.push("## Current Blocker Snapshot");
  lines.push("");
  lines.push(`- Missing staging detection: ${stagingMissing.length}`);
  lines.push(`- Missing staging only (no backup blocker): ${stagingOnly.length}`);
  lines.push(`- Missing staging + backup blocker: ${stagingPlusBackup.length}`);
  lines.push("");
  lines.push("## Recommended Next Manual Batch");
  lines.push("");

  if (recommended.length === 0) {
    lines.push("No remediation targets found. Re-generate queue and verify source data.");
  } else {
    if (stagingOnly.length > 0) {
      lines.push("Selection rule: prioritize apps blocked only on staging detection to unlock trigger-path testing fastest.");
    } else {
      lines.push("Selection rule: all remaining apps include backup blockers, so this batch minimizes count only.");
    }
    lines.push("");
    for (const row of recommended) {
      lines.push(`- ${row.app} (service=${row.serviceUuid || "-"}, project=${row.projectId || "-"})`);
    }
  }

  lines.push("");
  lines.push("## Manual Steps");
  lines.push("");
  lines.push("1. In Coolify, create/attach staging for each app in the recommended batch.");
  lines.push("2. If the app also has backup blocker, configure at least one automated backup schedule.");
  lines.push("3. Run `npm run ops:refresh-staging-remediation:strict` and verify delta/smoke artifacts.");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");

  console.log(`Wrote next remediation batch: ${outputFile}`);
  console.log(
    `Summary: missingStaging=${stagingMissing.length} stagingOnly=${stagingOnly.length} stagingPlusBackup=${stagingPlusBackup.length} recommended=${recommended.length}`
  );
}

try {
  main();
} catch (error) {
  console.error("export-staging-remediation-next-batch failed:", error.message);
  process.exit(1);
}