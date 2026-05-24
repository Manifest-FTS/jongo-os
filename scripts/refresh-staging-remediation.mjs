#!/usr/bin/env node

import { spawn } from "node:child_process";

const withSmoke = process.argv.includes("--with-smoke");
const strictSmoke = process.argv.includes("--strict-smoke");

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
}

run().catch((error) => {
  console.error("refresh-staging-remediation failed:", error.message);
  process.exit(1);
});
