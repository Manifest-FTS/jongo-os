const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const sessionCookie = (process.env.SESSION_COOKIE || "").trim();
const allowNoAuthLocal = (process.env.ALLOW_NO_AUTH_LOCAL || "false").toLowerCase() === "true";
const failOnBlocked = (process.env.FAIL_ON_BLOCKED || "true").toLowerCase() !== "false";
const discoveryScope = (process.env.STAGING_SITE_DISCOVERY_SCOPE || "linked").trim();

const cliIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const envIds = (process.env.STAGING_SITE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!token) {
  const isLocalBaseUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl);
  if (!sessionCookie && !(allowNoAuthLocal && isLocalBaseUrl)) {
    console.error("Missing authentication: set OWNERSHIP_SYNC_TOKEN or SESSION_COOKIE.");
    process.exit(1);
  }
}

function buildHeaders() {
  const headers = {
    Accept: "application/json"
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (sessionCookie) {
    headers.Cookie = sessionCookie;
  }

  return headers;
}

function maybeExplainAuthRedirect(status, bodyText, locationHeader) {
  const looksLikeRedirect = status >= 300 && status < 400;
  const loginLocation = typeof locationHeader === "string" && locationHeader.toLowerCase().includes("/auth/login");
  const loginBody = typeof bodyText === "string" && bodyText.toLowerCase().includes("/auth/login");

  if (looksLikeRedirect && (loginLocation || loginBody)) {
    return "Endpoint redirected to login. Provide SESSION_COOKIE for local/dev auth or use a reachable live APP_BASE_URL with valid token auth.";
  }

  return null;
}

function parseJsonResponse(status, text, locationHeader) {
  const authRedirectMessage = maybeExplainAuthRedirect(status, text, locationHeader);
  if (authRedirectMessage) {
    throw new Error(authRedirectMessage);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON response (${status}): ${text.slice(0, 250)}`);
  }
}

if (!token && !sessionCookie && !(allowNoAuthLocal && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl))) {
  console.error("Missing authentication: set OWNERSHIP_SYNC_TOKEN or SESSION_COOKIE.");
  process.exit(1);
}

async function discoverSiteIds() {
  const url = `${baseUrl}/api/sites/staging-targets?scope=${encodeURIComponent(discoveryScope)}`;
  const res = await fetch(url, {
    headers: buildHeaders(),
    redirect: "manual"
  });

  const text = await res.text();
  const body = parseJsonResponse(res.status, text, res.headers.get("location"));

  if (res.status !== 200) {
    throw new Error(`Discovery endpoint returned ${res.status}: ${body?.error || "unknown error"}`);
  }

  const sites = Array.isArray(body?.sites) ? body.sites : [];
  return sites
    .map((item) => item?.recommendedId)
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

async function readStagingReadiness(siteId) {
  const res = await fetch(`${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging`, {
    headers: buildHeaders(),
    redirect: "manual"
  });

  const text = await res.text();
  const body = parseJsonResponse(res.status, text, res.headers.get("location"));

  return { status: res.status, body };
}

function evaluateReadiness(result) {
  const readyForSyncTesting = result.body?.readyForSyncTesting === true;
  const actualSyncReady = result.body?.actualSyncTestReadiness?.ready === true;
  const blockers = Array.isArray(result.body?.actualSyncTestReadiness?.blockers)
    ? result.body.actualSyncTestReadiness.blockers
    : null;
  const preflightTone = result.body?.preflight?.productionToStaging?.tone;

  const contractPresent =
    typeof result.body?.readyForSyncTesting === "boolean" &&
    typeof result.body?.actualSyncTestReadiness?.ready === "boolean" &&
    Array.isArray(result.body?.actualSyncTestReadiness?.blockers) &&
    typeof preflightTone === "string";

  const go =
    readyForSyncTesting &&
    actualSyncReady &&
    preflightTone === "healthy" &&
    Array.isArray(blockers) &&
    blockers.length === 0;

  return {
    go,
    contractPresent,
    readyForSyncTesting,
    actualSyncReady,
    blockers: blockers ?? [],
    preflightTone: preflightTone ?? "unknown"
  };
}

function printResult(siteId, status, evaluation) {
  console.log(`\n[${siteId}] ${evaluation.go ? "GO" : "NO-GO"}`);
  console.log(`  HTTP: ${status}`);
  console.log(`  readyForSyncTesting: ${evaluation.readyForSyncTesting}`);
  console.log(`  actualSyncTestReadiness.ready: ${evaluation.actualSyncReady}`);
  console.log(`  actualSyncTestReadiness.blockers: ${evaluation.blockers.length}`);
  console.log(`  preflight.productionToStaging.tone: ${evaluation.preflightTone}`);

  if (evaluation.blockers.length > 0) {
    console.log("  Blockers:");
    for (const blocker of evaluation.blockers) {
      console.log(`   - ${blocker}`);
    }
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
      const result = await readStagingReadiness(siteId);

      if (result.status !== 200) {
        failures += 1;
        console.log(`\n[${siteId}] NO-GO`);
        console.log(`  HTTP: ${result.status}`);
        continue;
      }

      const evaluation = evaluateReadiness(result);
      printResult(siteId, result.status, evaluation);

      if (!evaluation.contractPresent) {
        failures += 1;
        console.log("  Contract mismatch: expected readiness fields are missing.");
        continue;
      }

      if (failOnBlocked && !evaluation.go) {
        failures += 1;
      }
    } catch (error) {
      failures += 1;
      console.error(`\n[${siteId}] ERROR: ${error.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\nStaging sync readiness smoke failed for ${failures} site(s).`);
    process.exit(1);
  }

  console.log("\nStaging sync readiness smoke passed.");
}

run().catch((error) => {
  console.error("Smoke script failed:", error.message);
  process.exit(1);
});
