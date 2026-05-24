#!/usr/bin/env node

const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const discoveryScope = (process.env.STAGING_SITE_DISCOVERY_SCOPE || "linked").trim();
const apply = process.argv.includes("--apply");

const cliIds = process.argv
  .slice(2)
  .filter((value) => value !== "--apply")
  .map((value) => value.trim())
  .filter(Boolean);

const envIds = (process.env.STAGING_SITE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!token) {
  console.error("Missing OWNERSHIP_SYNC_TOKEN.");
  process.exit(1);
}

function authHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
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

async function discoverSiteIds() {
  const url = `${baseUrl}/api/sites/staging-targets?scope=${encodeURIComponent(discoveryScope)}`;
  const res = await fetch(url, {
    headers: authHeaders(),
    redirect: "manual"
  });

  const body = await parseJsonResponse(res);
  if (res.status !== 200) {
    throw new Error(`Discovery failed ${res.status}: ${body?.error || "unknown error"}`);
  }

  const sites = Array.isArray(body?.sites) ? body.sites : [];
  return sites
    .map((item) => item?.recommendedId)
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

async function postStagingEnable(siteId) {
  const res = await fetch(`${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ enabled: true }),
    redirect: "manual"
  });
  const body = await parseJsonResponse(res);
  return { status: res.status, body };
}

async function run() {
  const siteIds = cliIds.length > 0
    ? cliIds
    : envIds.length > 0
      ? envIds
      : await discoverSiteIds();

  if (siteIds.length === 0) {
    console.error("No site IDs found.");
    process.exit(1);
  }

  console.log(`Targets: ${siteIds.length}`);
  console.log(`Mode: ${apply ? "apply" : "dry-run"}`);

  if (!apply) {
    console.log("Dry-run target list:");
    for (const siteId of siteIds) {
      console.log(`- ${siteId}`);
    }
    return;
  }

  let success = 0;
  let detected = 0;
  let provisioned = 0;
  let failed = 0;

  for (const siteId of siteIds) {
    const result = await postStagingEnable(siteId);
    const stagedDetected = Boolean(result.body?.stagedDetected);
    const stagedProvisioned = Boolean(result.body?.provisioned);

    if (result.status === 200) {
      success += 1;
      if (stagedDetected) detected += 1;
      if (stagedProvisioned) provisioned += 1;
      console.log(`[${siteId}] ok stagedDetected=${stagedDetected} provisioned=${stagedProvisioned} message=${result.body?.message || ""}`);
      continue;
    }

    failed += 1;
    console.log(`[${siteId}] fail status=${result.status} error=${result.body?.error || "unknown"}`);
  }

  console.log(`Summary: success=${success} detected=${detected} provisioned=${provisioned} failed=${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error("remediate-staging-provision failed:", error.message);
  process.exit(1);
});
