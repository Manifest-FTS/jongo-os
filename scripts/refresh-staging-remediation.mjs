#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const withSmoke = process.argv.includes("--with-smoke");
const strictSmoke = process.argv.includes("--strict-smoke");
const latestQueue = "docs/workflows/staging-remediation-queue-latest.md";
const previousQueue = "docs/workflows/staging-remediation-queue-previous.md";

function runStep(label, command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        ...extraEnv
      }
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

async function run() {
  console.log("Refreshing staging remediation artifacts...");

  const latestQueuePath = path.resolve(process.cwd(), latestQueue);
  const previousQueuePath = path.resolve(process.cwd(), previousQueue);
  if (fs.existsSync(latestQueuePath)) {
    fs.mkdirSync(path.dirname(previousQueuePath), { recursive: true });
    fs.copyFileSync(latestQueuePath, previousQueuePath);
    console.log(`Snapshot saved: ${previousQueue}`);
  } else {
    console.log("No previous latest queue found; delta will compare against empty baseline.");
  }

  await runStep(
    "Export staging remediation queue",
    "npm",
    ["run", "ops:export-staging-remediation-queue"]
  );

  await runStep(
    "Generate staging remediation tracker",
    "npm",
    ["run", "ops:generate-staging-remediation-tracker"]
  );

  await runStep(
    "Export staging remediation delta",
    "npm",
    ["run", "ops:export-staging-remediation-delta"]
  );

  if (withSmoke) {
    await runStep(
      strictSmoke ? "Run strict staging promote smoke" : "Run non-strict staging promote smoke",
      "npm",
      ["run", "smoke:staging-promote"],
      {
        FAIL_ON_BLOCKED: strictSmoke ? "true" : "false"
      }
    );
  }

  console.log("\nRefresh complete.");
  console.log("Artifacts:");
  console.log("- docs/workflows/staging-remediation-queue-latest.md");
  console.log("- docs/workflows/staging-remediation-tracker-latest.md");
  console.log("- docs/workflows/staging-remediation-delta-latest.md");
}

run().catch((error) => {
  console.error("refresh-staging-remediation failed:", error.message);
  process.exit(1);
});
