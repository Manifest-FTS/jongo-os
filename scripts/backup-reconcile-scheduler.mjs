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

  console.log(
    `[backup-reconcile] scanned=${scanned} autoProvisioned=${autoProvisioned} alreadyConfigured=${alreadyConfigured} failed=${failed}`
  );
}

async function runWithSchedule() {
  const intervalMinutes = toPositiveInt(process.env.BACKUP_RECONCILE_INTERVAL_MINUTES, 60);
  const intervalMs = intervalMinutes * 60 * 1000;
  const runImmediate = (process.env.BACKUP_RECONCILE_RUN_IMMEDIATE || "true").trim().toLowerCase() !== "false";

  console.log(`[backup-reconcile] scheduler enabled (every ${intervalMinutes} minute(s))`);

  if (runImmediate) {
    try {
      await runReconcileOnce();
    } catch (error) {
      console.error(`[backup-reconcile] initial run failed: ${error instanceof Error ? error.message : String(error)}`);
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
