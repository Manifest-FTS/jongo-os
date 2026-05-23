const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const failOnBlocked = (process.env.FAIL_ON_BLOCKED || "true").toLowerCase() !== "false";

const cliIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const envIds = (process.env.STAGING_SITE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const siteIds = cliIds.length > 0 ? cliIds : envIds;

if (!token) {
  console.error("Missing OWNERSHIP_SYNC_TOKEN env var.");
  process.exit(1);
}

if (siteIds.length === 0) {
  console.error("No site IDs provided. Pass IDs as args or set STAGING_SITE_IDS=site-a,site-b");
  process.exit(1);
}

async function readPreflight(siteId) {
  const res = await fetch(`${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    redirect: "manual"
  });

  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON for ${siteId}: ${text.slice(0, 200)}`);
  }

  return { status: res.status, body };
}

function printRow(siteId, result) {
  const ready = Boolean(result.body?.readyForSyncTesting);
  const blockers = Array.isArray(result.body?.blockers) ? result.body.blockers : [];
  const preflight = result.body?.preflight?.productionToStaging;
  const tone = preflight?.tone || "unknown";
  const label = preflight?.label || "unknown";

  console.log(`\n[${siteId}] ${ready ? "READY" : "NOT READY"}`);
  console.log(`  HTTP: ${result.status}`);
  console.log(`  Preflight: ${label} (${tone})`);

  if (blockers.length > 0) {
    console.log("  Blockers:");
    for (const blocker of blockers) {
      console.log(`   - ${blocker}`);
    }
  }

  const target = result.body?.dryRunPlan?.target;
  if (target) {
    console.log(`  Dry-run target: ${target.name} (${target.environment})`);
  }
}

async function run() {
  let failures = 0;

  for (const siteId of siteIds) {
    try {
      const result = await readPreflight(siteId);
      printRow(siteId, result);

      if (result.status !== 200) {
        failures += 1;
        continue;
      }

      if (failOnBlocked && !result.body?.readyForSyncTesting) {
        failures += 1;
      }
    } catch (error) {
      failures += 1;
      console.error(`\n[${siteId}] ERROR: ${error.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\nStaging preflight smoke failed for ${failures} site(s).`);
    process.exit(1);
  }

  console.log("\nStaging preflight smoke passed.");
}

run().catch((error) => {
  console.error("Smoke script failed:", error.message);
  process.exit(1);
});
