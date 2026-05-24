const baseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
const sessionCookie = (process.env.SESSION_COOKIE || "").trim();
const allowNoAuthLocal = (process.env.ALLOW_NO_AUTH_LOCAL || "false").toLowerCase() === "true";
const discoveryScope = (process.env.STAGING_SITE_DISCOVERY_SCOPE || "linked").trim();
const failOnBlocked = (process.env.FAIL_ON_BLOCKED || "false").toLowerCase() === "true";
const allowProductionTrigger = (process.env.ALLOW_PRODUCTION_TRIGGER || "false").toLowerCase() === "true";
const checkAttemptEndpoint = (process.env.CHECK_PROMOTE_ATTEMPT_ENDPOINT || "true").toLowerCase() !== "false";

const cliIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const envIds = (process.env.STAGING_SITE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const isLocalBaseUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl);

if (!token && !sessionCookie && !(allowNoAuthLocal && isLocalBaseUrl)) {
  console.error("Missing authentication: set OWNERSHIP_SYNC_TOKEN or SESSION_COOKIE.");
  process.exit(1);
}

function buildHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
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

function randomIdempotencyKey(siteId) {
  const slug = siteId
    .replace(/[^a-zA-Z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "site";

  return `smoke-promote:${slug}:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;
}

async function parseJsonResponse(res) {
  const text = await res.text();

  const authRedirectMessage = maybeExplainAuthRedirect(res.status, text, res.headers.get("location"));
  if (authRedirectMessage) {
    throw new Error(authRedirectMessage);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON response (${res.status}): ${text.slice(0, 250)}`);
  }
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

  const body = await parseJsonResponse(res);
  if (res.status !== 200) {
    throw new Error(`Discovery endpoint returned ${res.status}: ${body?.error || "unknown error"}`);
  }

  const sites = Array.isArray(body?.sites) ? body.sites : [];
  return sites
    .map((item) => item?.recommendedId)
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

async function postPromote(siteId, idempotencyKey) {
  const res = await fetch(`${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging/promote`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      confirmationPhrase: "PROMOTE",
      idempotencyKey
    }),
    redirect: "manual"
  });

  const body = await parseJsonResponse(res);
  return { status: res.status, body };
}

async function readPromoteAttempt(siteId, attemptId) {
  const res = await fetch(
    `${baseUrl}/api/sites/${encodeURIComponent(siteId)}/staging/promote-attempt?attemptId=${encodeURIComponent(attemptId)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      redirect: "manual"
    }
  );

  const body = await parseJsonResponse(res);
  return { status: res.status, body };
}

function validateBlockedResponse(result) {
  const reason = result.body?.blockingReason;
  const actionHint = result.body?.actionHint;
  const attemptId = result.body?.promoteAttemptId;

  if (typeof reason !== "string" || reason.length === 0) {
    return "blocked response missing blockingReason";
  }

  if (typeof actionHint !== "string" || actionHint.length === 0) {
    return "blocked response missing actionHint";
  }

  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return "blocked response missing promoteAttemptId";
  }

  if (result.status === 429) {
    const retryAfter = result.body?.retryAfterSeconds;
    if (typeof retryAfter !== "number" || retryAfter < 1) {
      return "429 blocked response missing retryAfterSeconds";
    }
  }

  return null;
}

function validateTriggeredResponse(result) {
  const attemptId = result.body?.promoteAttemptId;
  const mode = result.body?.mode;

  if (result.body?.ok !== true) {
    return "trigger response missing ok=true";
  }

  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return "trigger response missing promoteAttemptId";
  }

  if (typeof mode !== "string" || mode.length === 0) {
    return "trigger response missing mode";
  }

  return null;
}

async function runForSite(siteId) {
  const idempotencyKey = randomIdempotencyKey(siteId);
  console.log(`\n[${siteId}] promote smoke with idempotency key ${idempotencyKey}`);

  const first = await postPromote(siteId, idempotencyKey);
  console.log(`  first promote HTTP: ${first.status}`);

  if (first.status === 200) {
    const triggerValidationError = validateTriggeredResponse(first);
    if (triggerValidationError) {
      throw new Error(triggerValidationError);
    }

    const attemptId = first.body.promoteAttemptId;
    console.log(`  triggered attempt: ${attemptId}`);

    if (!allowProductionTrigger) {
      throw new Error(
        "promotion triggered successfully, but ALLOW_PRODUCTION_TRIGGER is false. " +
        "Set ALLOW_PRODUCTION_TRIGGER=true to run trigger-path smoke intentionally."
      );
    }

    const replay = await postPromote(siteId, idempotencyKey);
    console.log(`  replay promote HTTP: ${replay.status}`);

    if (replay.status !== 200 || replay.body?.replayed !== true) {
      throw new Error("idempotency replay check failed (expected HTTP 200 with replayed=true)");
    }

    if (checkAttemptEndpoint) {
      const attempt = await readPromoteAttempt(siteId, attemptId);
      console.log(`  attempt endpoint HTTP: ${attempt.status}`);
      if (attempt.status !== 200 || attempt.body?.ok !== true) {
        throw new Error("promote-attempt endpoint check failed after trigger");
      }
    }

    return { blocked: false, triggered: true };
  }

  if (first.status === 409 || first.status === 429) {
    const blockedValidationError = validateBlockedResponse(first);
    if (blockedValidationError) {
      throw new Error(blockedValidationError);
    }

    console.log(`  blocked reason: ${first.body.blockingReason}`);
    if (first.body.retryAfterSeconds) {
      console.log(`  retry after: ${first.body.retryAfterSeconds}s`);
    }

    const attemptId = first.body?.promoteAttemptId;
    if (checkAttemptEndpoint && typeof attemptId === "string" && attemptId.length > 0) {
      const attempt = await readPromoteAttempt(siteId, attemptId);
      console.log(`  attempt endpoint HTTP: ${attempt.status}`);
      if (attempt.status !== 200 || attempt.body?.ok !== true) {
        throw new Error("promote-attempt endpoint check failed after blocked response");
      }
    }

    return { blocked: true, triggered: false };
  }

  throw new Error(`unexpected promote status ${first.status}: ${first.body?.error || "unknown error"}`);
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
  let blockedCount = 0;
  let triggeredCount = 0;

  for (const siteId of siteIds) {
    try {
      const result = await runForSite(siteId);
      blockedCount += result.blocked ? 1 : 0;
      triggeredCount += result.triggered ? 1 : 0;

      if (result.blocked && failOnBlocked) {
        failures += 1;
        console.error(`  [${siteId}] blocked promote considered failure because FAIL_ON_BLOCKED=true`);
      }
    } catch (error) {
      failures += 1;
      console.error(`  [${siteId}] ERROR: ${error.message}`);
    }
  }

  console.log(`\nSummary: triggered=${triggeredCount}, blocked=${blockedCount}, failed=${failures}`);

  if (failures > 0) {
    process.exit(1);
  }

  console.log("Promote smoke passed.");
}

run().catch((error) => {
  console.error("Promote smoke failed:", error.message);
  process.exit(1);
});
