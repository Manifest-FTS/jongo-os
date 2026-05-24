#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const previousFile = process.env.PREVIOUS_QUEUE_FILE || "docs/workflows/staging-remediation-queue-previous.md";
const currentFile = process.env.CURRENT_QUEUE_FILE || "docs/workflows/staging-remediation-queue-latest.md";
const outputFile = process.env.OUTPUT_FILE || "docs/workflows/staging-remediation-delta-latest.md";

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
      stagingDetected: cols[3] === "yes",
      stagingAppUuid: cols[4] === "-" ? "" : cols[4],
      blockers: cols[5],
      suggestedActions: cols[6]
    });
  }

  return rows;
}

function byApp(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.app, row);
  }
  return map;
}

function readQueue(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return parseQueueTable(fs.readFileSync(filePath, "utf8"));
}

function splitSemicolonList(value) {
  return value
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function main() {
  const previousPath = path.resolve(process.cwd(), previousFile);
  const currentPath = path.resolve(process.cwd(), currentFile);
  const outputPath = path.resolve(process.cwd(), outputFile);

  const prevRows = readQueue(previousPath);
  const currRows = readQueue(currentPath);

  if (currRows.length === 0) {
    throw new Error("Current queue has no rows. Generate latest queue first.");
  }

  const prevMap = byApp(prevRows);
  const currMap = byApp(currRows);

  const allApps = Array.from(new Set([...prevMap.keys(), ...currMap.keys()])).sort((a, b) => a.localeCompare(b));

  const addedApps = [];
  const removedApps = [];
  const stagingImproved = [];
  const stagingRegressed = [];
  const blockerChanged = [];

  for (const app of allApps) {
    const prev = prevMap.get(app);
    const curr = currMap.get(app);

    if (!prev && curr) {
      addedApps.push(app);
      continue;
    }

    if (prev && !curr) {
      removedApps.push(app);
      continue;
    }

    if (!prev || !curr) {
      continue;
    }

    if (!prev.stagingDetected && curr.stagingDetected) {
      stagingImproved.push(app);
    } else if (prev.stagingDetected && !curr.stagingDetected) {
      stagingRegressed.push(app);
    }

    if (prev.blockers !== curr.blockers) {
      const prevBlockers = splitSemicolonList(prev.blockers);
      const currBlockers = splitSemicolonList(curr.blockers);
      blockerChanged.push({
        app,
        previous: prevBlockers,
        current: currBlockers
      });
    }
  }

  const currentMissingStaging = currRows.filter((row) => !row.stagingDetected).length;
  const currentBackupBlocked = currRows.filter((row) => row.blockers.toLowerCase().includes("backups not configured")).length;
  const generatedAt = new Date().toISOString();

  const lines = [];
  lines.push("# Staging Remediation Delta (Latest)");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Previous queue: ${previousFile}`);
  lines.push(`Current queue: ${currentFile}`);
  lines.push("");
  lines.push("## Current Totals");
  lines.push("");
  lines.push(`- Current apps in queue: ${currRows.length}`);
  lines.push(`- Current missing staging detection: ${currentMissingStaging}`);
  lines.push(`- Current backup blocker count: ${currentBackupBlocked}`);
  lines.push("");
  lines.push("## Delta Summary");
  lines.push("");
  lines.push(`- Apps added to queue: ${addedApps.length}`);
  lines.push(`- Apps removed from queue: ${removedApps.length}`);
  lines.push(`- Staging detection improved (no -> yes): ${stagingImproved.length}`);
  lines.push(`- Staging detection regressed (yes -> no): ${stagingRegressed.length}`);
  lines.push(`- Apps with blocker changes: ${blockerChanged.length}`);
  lines.push("");

  if (addedApps.length > 0) {
    lines.push("### Added Apps");
    lines.push("");
    for (const app of addedApps) {
      lines.push(`- ${app}`);
    }
    lines.push("");
  }

  if (removedApps.length > 0) {
    lines.push("### Removed Apps");
    lines.push("");
    for (const app of removedApps) {
      lines.push(`- ${app}`);
    }
    lines.push("");
  }

  if (stagingImproved.length > 0) {
    lines.push("### Staging Detection Improved");
    lines.push("");
    for (const app of stagingImproved) {
      lines.push(`- ${app}`);
    }
    lines.push("");
  }

  if (stagingRegressed.length > 0) {
    lines.push("### Staging Detection Regressed");
    lines.push("");
    for (const app of stagingRegressed) {
      lines.push(`- ${app}`);
    }
    lines.push("");
  }

  if (blockerChanged.length > 0) {
    lines.push("### Blocker Changes");
    lines.push("");
    for (const item of blockerChanged) {
      lines.push(`- ${item.app}`);
      lines.push(`  - previous: ${item.previous.length > 0 ? item.previous.join("; ") : "(none)"}`);
      lines.push(`  - current: ${item.current.length > 0 ? item.current.join("; ") : "(none)"}`);
    }
    lines.push("");
  }

  if (
    addedApps.length === 0 &&
    removedApps.length === 0 &&
    stagingImproved.length === 0 &&
    stagingRegressed.length === 0 &&
    blockerChanged.length === 0
  ) {
    lines.push("No queue changes detected since previous snapshot.");
    lines.push("");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");

  console.log(`Wrote remediation delta: ${outputFile}`);
  console.log(
    `Summary: added=${addedApps.length} removed=${removedApps.length} improved=${stagingImproved.length} blockerChanged=${blockerChanged.length}`
  );
}

try {
  main();
} catch (error) {
  console.error("export-staging-remediation-delta failed:", error.message);
  process.exit(1);
}
