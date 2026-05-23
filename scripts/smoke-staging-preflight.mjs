const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const failOnBlocked = (process.env.FAIL_ON_BLOCKED || "true").toLowerCase() !== "false";
const discoveryScope = (process.env.STAGING_SITE_DISCOVERY_SCOPE || "linked").trim();

const cliIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const envIds = (process.env.STAGING_SITE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!token) {
  console.error("Missing OWNERSHIP_SYNC_TOKEN env var.");
  process.exit(1);
}

async function discoverSiteIds() {
  const url = `${baseUrl}/api/sites/staging-targets?scope=${encodeURIComponent(discoveryScope)}`;
  const res = await fetch(url, {
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
    throw new Error(`Invalid JSON from staging-targets endpoint: ${text.slice(0, 200)}`);
  }

  if (res.status !== 200) {
    throw new Error(`Discovery endpoint returned ${res.status}: ${body?.error || "unknown error"}`);
  }

  const sites = Array.isArray(body?.sites) ? body.sites : [];
  return sites
    .map((item) => item?.recommendedId)
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
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
  const siteIds = cliIds.length > 0
    ? cliIds
    : envIds.length > 0
      ? envIds
      : await discoverSiteIds();

  if (siteIds.length === 0) {
    console.error("No site IDs found. Pass IDs as args, set STAGING_SITE_IDS, or ensure discovery endpoint returns sites.");
    process.exit(1);
  }

  if (cliIds.length === 0 && envIds.length === 0) {
    console.log(`Discovered ${siteIds.length} site(s) dynamically using scope='${discoveryScope}'.`);
  }

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
