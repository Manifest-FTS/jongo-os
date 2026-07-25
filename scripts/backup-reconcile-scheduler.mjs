function normalizeBaseUrl(value) {
  if (!value) {
    return "";
  }

  return value.trim().replace(/\/+$/, "");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function resolveReconcileUrl() {
  const directUrl = (process.env.BACKUP_RECONCILE_URL || "").trim();
  if (directUrl) {
    return directUrl;
  }

  const nextAuthBase = normalizeBaseUrl(process.env.NEXTAUTH_URL);
  if (nextAuthBase) {
    return `${nextAuthBase}/api/ops/backup-reconcile`;
  }

  const port = (process.env.PORT || "3000").trim() || "3000";
  return `http://127.0.0.1:${port}/api/ops/backup-reconcile`;
}

async function runReconcileOnce() {
  const url = resolveReconcileUrl();
  const token = (process.env.BACKUP_RECONCILE_TOKEN || "").trim();
  const limit = toPositiveInt(process.env.BACKUP_RECONCILE_LIMIT, 200);

  if (!token) {
    throw new Error("BACKUP_RECONCILE_TOKEN is required");
  }

  const endpoint = `${url}${url.includes("?") ? "&" : "?"}limit=${limit}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload && typeof payload === "object" && payload !== null && typeof payload.error === "string"
      ? payload.error
      : `HTTP ${response.status}`;
    throw new Error(`backup reconcile failed: ${message}`);
  }

  const scanned = payload && typeof payload === "object" && payload !== null && typeof payload.scanned === "number"
    ? payload.scanned
    : 0;
  const autoProvisioned = payload && typeof payload === "object" && payload !== null && typeof payload.autoProvisioned === "number"
    ? payload.autoProvisioned
    : 0;
  const alreadyConfigured = payload && typeof payload === "object" && payload !== null && typeof payload.alreadyConfigured === "number"
    ? payload.alreadyConfigured
    : 0;
  const failed = payload && typeof payload === "object" && payload !== null && typeof payload.failed === "number"
    ? payload.failed
    : 0;

  // Scheduled backups are the whole point of this loop, so they belong in the
  // line. Without them a pass that started nothing, or silently skipped every
  // site, looks identical to a healthy one.
  // A cold run whose Coolify calls all came back empty reports scanned=43 with
  // zero of everything and failed=0 — indistinguishable from a healthy pass
  // unless the completeness flag is on the line.
  const lifecycle = payload && typeof payload === "object" ? payload.lifecycle : null;
  const indexComplete = lifecycle && typeof lifecycle === "object" ? lifecycle.indexComplete !== false : true;

  const sched = payload && typeof payload === "object" ? payload.scheduledBackups : null;
  const started = sched && Array.isArray(sched.started) ? sched.started : [];
  const skipped = sched && Array.isArray(sched.skipped) ? sched.skipped : [];

  console.log(
    `[backup-reconcile] scanned=${scanned} autoProvisioned=${autoProvisioned} ` +
      `alreadyConfigured=${alreadyConfigured} failed=${failed} ` +
      `backupsStarted=${started.length}${started.length ? `(${started.join(",")})` : ""} ` +
      `backupsSkipped=${skipped.length}${skipped.length ? `(${skipped.join(",")})` : ""}` +
      (indexComplete ? "" : " WARNING=incomplete_resource_index")
  );
}

async function runWithSchedule() {
  const intervalMinutes = toPositiveInt(process.env.BACKUP_RECONCILE_INTERVAL_MINUTES, 60);
  const intervalMs = intervalMinutes * 60 * 1000;
  const runImmediate = (process.env.BACKUP_RECONCILE_RUN_IMMEDIATE || "true").trim().toLowerCase() !== "false";

  console.log(`[backup-reconcile] scheduler enabled (every ${intervalMinutes} minute(s))`);

  if (runImmediate) {
    // The scheduler starts alongside the web server, so the first attempt
    // usually loses the race and 502s. Without a retry the platform is blind
    // for a full interval after every deploy, which is exactly when a backup
    // is most likely to be due.
    const attempts = toPositiveInt(process.env.BACKUP_RECONCILE_STARTUP_ATTEMPTS, 5);
    const backoffMs = toPositiveInt(process.env.BACKUP_RECONCILE_STARTUP_BACKOFF_MS, 15000);
    let ran = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await runReconcileOnce();
        ran = true;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === attempts) {
          console.error(`[backup-reconcile] initial run failed after ${attempts} attempts: ${message}`);
        } else {
          console.warn(`[backup-reconcile] initial run attempt ${attempt}/${attempts} failed (${message}); retrying in ${backoffMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
    if (ran) {
      console.log("[backup-reconcile] initial run completed");
    }
  }

  setInterval(async () => {
    try {
      await runReconcileOnce();
    } catch (error) {
      console.error(`[backup-reconcile] scheduled run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, intervalMs);
}

const once = process.argv.includes("--once");
if (once) {
  try {
    await runReconcileOnce();
    process.exit(0);
  } catch (error) {
    console.error(`[backup-reconcile] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  await runWithSchedule();
}
